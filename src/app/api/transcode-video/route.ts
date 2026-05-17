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

type ProbeResult = {
  codec: string | null;
  formatName: string | null;
  duration: number | null;
};

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

    const { codec, formatName } = await probeVideo(inputPath);
    const isHevc = codec === "hevc" || codec === "h265";
    const isMovContainer =
      (formatName ?? "").includes("mov") ||
      (formatName ?? "").includes("quicktime") ||
      /\.(mov|m4v)$/i.test(file.name);

    // Anything MOV-container or HEVC gets a full re-encode. A naive `-c copy`
    // remux preserves variable frame rate and out-of-order PTS, which causes
    // the "section repeats / freeze near end" symptoms during browser
    // playback. We always normalize to constant 30 fps H.264 with predictable
    // GOP boundaries.
    const needsReencode = isHevc || isMovContainer;

    if (!needsReencode) {
      return new Response(null, {
        status: 204,
        headers: {
          "x-original-codec": codec ?? "unknown",
          "x-original-format": formatName ?? "unknown",
        },
      });
    }

    await runFfmpeg(reencodeArgs(inputPath, outputPath));

    const output = await probeVideo(outputPath);
    const data = await fs.readFile(outputPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": "video/mp4",
        "x-transcoded": "reencode",
        "x-original-codec": codec ?? "unknown",
        "x-original-format": formatName ?? "unknown",
        "x-output-duration": output.duration != null ? output.duration.toFixed(3) : "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`transcode failed: ${message}`, { status: 500 });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function reencodeArgs(inputPath: string, outputPath: string): string[] {
  // The filter chain handles VFR → CFR via `fps=30`, downscales the longest
  // edge to 720 px keeping the aspect ratio, and forces 8-bit 4:2:0 so the
  // output decodes on every browser (Dolby Vision / HEVC Main 10 sources are
  // 10-bit 4:2:0).
  const vf = [
    "fps=30",
    "scale=w=720:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    "format=yuv420p",
  ].join(",");

  return [
    "-y",
    // Regenerate PTS from packet order so iPhone clips with non-monotonic
    // timestamps don't produce duplicate / out-of-order frames downstream.
    "-fflags",
    "+genpts",
    "-i",
    inputPath,
    // iPhone MOVs typically carry: video, real AAC, a "phantom" extra audio
    // stream with no decodable codec, and several data streams (timecode,
    // gyro, spatial-audio metadata). Explicitly map only the first video and
    // first audio stream — `?` makes audio optional in case the source is
    // silent. Without this, ffmpeg attempts to copy the phantom streams and
    // can fail or produce a broken MP4.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    // Drop side-data (Dolby Vision RPU, ambient-viewing-env, custom metadata)
    // that browsers and Remotion don't need and that occasionally trip up
    // downstream tools.
    "-map_metadata",
    "-1",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "fastdecode",
    "-crf",
    "23",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-refs",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    // Resample audio to keep it in lock-step with the new CFR video timeline;
    // without this, audio can slip a few hundred ms behind on long clips.
    "-async",
    "1",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

function sanitizeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name:format=format_name,duration",
      "-select_streams",
      "v:0",
      "-of",
      "json",
      inputPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.on("error", () =>
      resolve({ codec: null, formatName: null, duration: null }),
    );
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout || "{}");
        const codec =
          (parsed.streams?.[0]?.codec_name as string | undefined)?.toLowerCase() ??
          null;
        const formatName =
          (parsed.format?.format_name as string | undefined)?.toLowerCase() ?? null;
        const durStr = parsed.format?.duration as string | undefined;
        const duration = durStr != null ? Number(durStr) : null;
        resolve({
          codec,
          formatName,
          duration: duration != null && Number.isFinite(duration) ? duration : null,
        });
      } catch {
        resolve({ codec: null, formatName: null, duration: null });
      }
    });
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
