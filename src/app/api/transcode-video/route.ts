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
    const needsReencode = codec === "hevc" || codec === "h265";
    const isMovContainer =
      (formatName ?? "").includes("mov") || /\.(mov|m4v)$/i.test(file.name);
    const needsRemux = !needsReencode && codec === "h264" && isMovContainer;

    if (!needsReencode && !needsRemux) {
      return new Response(null, {
        status: 204,
        headers: {
          "x-original-codec": codec ?? "unknown",
          "x-original-format": formatName ?? "unknown",
        },
      });
    }

    if (needsRemux) {
      // Fast path: copy H.264 stream into a clean MP4 with faststart so the
      // browser can seek before the full file downloads. Also rewrite PTS to
      // avoid negative timestamps that some iPhone clips emit.
      await runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-fflags",
        "+genpts",
        "-avoid_negative_ts",
        "make_zero",
        outputPath,
      ]);
    } else {
      await runFfmpeg(reencodeArgs(inputPath, outputPath));
    }

    const data = await fs.readFile(outputPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": "video/mp4",
        "x-transcoded": needsRemux ? "remux" : "reencode",
        "x-original-codec": codec ?? "unknown",
        "x-original-format": formatName ?? "unknown",
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
  return [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "scale=w=720:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    "-r",
    "30",
    // Constant frame rate — drops/duplicates frames as needed so seeks land
    // on predictable timestamps (iPhone clips are often VFR).
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "fastdecode",
    "-crf",
    "23",
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
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
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
      "stream=codec_name:format=format_name",
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
    proc.on("error", () => resolve({ codec: null, formatName: null }));
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout || "{}");
        const codec =
          (parsed.streams?.[0]?.codec_name as string | undefined)?.toLowerCase() ??
          null;
        const formatName =
          (parsed.format?.format_name as string | undefined)?.toLowerCase() ?? null;
        resolve({ codec, formatName });
      } catch {
        resolve({ codec: null, formatName: null });
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
