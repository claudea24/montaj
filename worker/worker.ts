import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeVideo, reencodeArgs, runFfmpeg } from "./transcode.ts";

type JobStatus = "pending" | "processing" | "done" | "failed";

type TranscodeJob = {
  id: string;
  user_id: string;
  project_id: string;
  input_path: string;
  output_path: string | null;
  name: string;
  status: JobStatus;
  attempts: number;
};

const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const BUCKET = process.env.SUPABASE_BUCKET ?? "montaj-media";
const WORKER_ID =
  process.env.RAILWAY_REPLICA_ID ?? `worker-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "2000");
const CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.WORKER_CONCURRENCY ?? "2")),
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let activeJobs = 0;
let shuttingDown = false;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function claimJob(): Promise<TranscodeJob | null> {
  const { data, error } = await supabase.rpc("claim_transcode_job", {
    worker: WORKER_ID,
  });
  if (error) {
    console.error("[worker] claim error:", error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as TranscodeJob | null;
}

async function markFailed(jobId: string, message: string) {
  await supabase
    .from("transcode_jobs")
    .update({ status: "failed" as JobStatus, error_message: message })
    .eq("id", jobId);
}

async function processJob(job: TranscodeJob) {
  activeJobs++;
  const tag = `[${WORKER_ID} ${job.id.slice(0, 8)}]`;
  console.log(`${tag} processing ${job.input_path}`);

  const workDir = path.join(tmpdir(), `montaj-${job.id}`);
  await fs.mkdir(workDir, { recursive: true });
  const inputPath = path.join(workDir, "input.bin");
  const outputPath = path.join(workDir, "out.mp4");

  try {
    // 1. Download the raw source from Supabase storage.
    const { data: dl, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(job.input_path);
    if (dlErr || !dl) {
      throw new Error(`download failed: ${dlErr?.message ?? "no data"}`);
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    await fs.writeFile(inputPath, buf);

    // 2. Transcode.
    await runFfmpeg(reencodeArgs(inputPath, outputPath));

    // 3. Probe the output for canonical duration / dimensions.
    const probe = await probeVideo(outputPath);
    const outBuf = await fs.readFile(outputPath);

    // 4. Upload the transcoded MP4. Output key is derived from the raw key:
    //    {userId}/{projectId}/raw/{uuid}-{name}.mov
    //      → {userId}/{projectId}/{uuid}-{name}.mp4
    const outputKey = job.input_path
      .replace(/\/raw\//, "/")
      .replace(/\.[^./]+$/i, "")
      .concat(".mp4");

    const { error: ulErr } = await supabase.storage
      .from(BUCKET)
      .upload(outputKey, outBuf, {
        contentType: "video/mp4",
        upsert: true,
        cacheControl: "3600",
      });
    if (ulErr) throw new Error(`upload failed: ${ulErr.message}`);

    // 5. Insert the asset row. We use the worker's service-role privileges,
    //    so RLS doesn't apply; we still set user_id explicitly so the
    //    asset is scoped to the owner.
    const baseName = path
      .basename(outputKey)
      .replace(/^[0-9a-f-]{36}-/, "");
    const { data: asset, error: insErr } = await supabase
      .from("assets")
      .insert({
        user_id: job.user_id,
        project_id: job.project_id,
        kind: "video",
        name: baseName,
        size_bytes: outBuf.length,
        storage_path: outputKey,
        duration_seconds: probe.duration,
        width: probe.width,
        height: probe.height,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(`asset insert failed: ${insErr.message}`);

    // 6. Mark job done. Client subscribes / polls this row.
    const { error: doneErr } = await supabase
      .from("transcode_jobs")
      .update({
        status: "done" as JobStatus,
        output_path: outputKey,
        asset_id: asset.id,
        duration_seconds: probe.duration,
        width: probe.width,
        height: probe.height,
      })
      .eq("id", job.id);
    if (doneErr) throw new Error(`finalize failed: ${doneErr.message}`);

    // 7. Best-effort cleanup of the raw upload — keeps the bucket tidy.
    //    Failure here is non-fatal: the asset is already minted.
    await supabase.storage
      .from(BUCKET)
      .remove([job.input_path])
      .catch(() => undefined);

    console.log(`${tag} done → ${outputKey}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} failed: ${message}`);
    await markFailed(job.id, message).catch(() => undefined);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    activeJobs--;
  }
}

async function loop() {
  console.log(
    `[${WORKER_ID}] started, concurrency=${CONCURRENCY}, poll=${POLL_INTERVAL_MS}ms`,
  );
  while (!shuttingDown) {
    if (activeJobs >= CONCURRENCY) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      const job = await claimJob();
      if (job) {
        // Fire-and-forget; the concurrency gate above limits parallelism.
        void processJob(job);
      } else {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      console.error("[worker] loop error:", err);
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
  // Wait for in-flight jobs to finish before exiting.
  while (activeJobs > 0) {
    console.log(`[${WORKER_ID}] draining: ${activeJobs} active`);
    await sleep(500);
  }
  console.log(`[${WORKER_ID}] stopped`);
}

process.on("SIGTERM", () => {
  console.log(`[${WORKER_ID}] SIGTERM received`);
  shuttingDown = true;
});
process.on("SIGINT", () => {
  console.log(`[${WORKER_ID}] SIGINT received`);
  shuttingDown = true;
});

loop().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
