import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_INPUT_BYTES = 250 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("video");
  if (!(file instanceof File)) {
    return new Response("missing video field", { status: 400 });
  }
  if (file.size > MAX_INPUT_BYTES) {
    return new Response(`file too large (${file.size} > ${MAX_INPUT_BYTES})`, {
      status: 413,
    });
  }

  const workDir = path.join(tmpdir(), `montaj-transcode-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const inputPath = path.join(workDir, sanitizeName(file.name) || "input.mov");
  const outputPath = path.join(workDir, "out.mp4");

  try {
    await pipeline(
      Readable.fromWeb(file.stream() as never),
      createWriteStream(inputPath),
    );

    const codec = await probeVideoCodec(inputPath);
    if (codec !== "hevc" && codec !== "h265") {
      return new Response(null, {
        status: 204,
        headers: { "x-original-codec": codec ?? "unknown" },
      });
    }

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    const data = await fs.readFile(outputPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": "video/mp4",
        "x-transcoded": "1",
        "x-original-codec": codec,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`transcode failed: ${message}`, { status: 500 });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function sanitizeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function probeVideoCodec(inputPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=nw=1:nk=1",
      inputPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => resolve(stdout.trim().toLowerCase() || null));
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}
