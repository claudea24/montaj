import { spawn } from "node:child_process";

export type ProbeResult = {
  codec: string | null;
  formatName: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
};

/** Mirrors src/app/api/transcode-video/route.ts so dev (Vercel) and prod
 *  (Railway) produce byte-equivalent output for the same input. */
export function reencodeArgs(inputPath: string, outputPath: string): string[] {
  const vf = [
    "fps=30",
    "scale=w=720:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    "format=yuv420p",
  ].join(",");

  return [
    "-y",
    "-fflags",
    "+genpts",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
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
    "-async",
    "1",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

export function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height:format=format_name,duration",
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
      resolve({
        codec: null,
        formatName: null,
        duration: null,
        width: null,
        height: null,
      }),
    );
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout || "{}");
        const stream = parsed.streams?.[0] ?? {};
        const codec = (stream.codec_name as string | undefined)?.toLowerCase() ?? null;
        const formatName =
          (parsed.format?.format_name as string | undefined)?.toLowerCase() ?? null;
        const durStr = parsed.format?.duration as string | undefined;
        const duration = durStr != null ? Number(durStr) : null;
        const width = stream.width != null ? Number(stream.width) : null;
        const height = stream.height != null ? Number(stream.height) : null;
        resolve({
          codec,
          formatName,
          duration:
            duration != null && Number.isFinite(duration) && duration > 0
              ? duration
              : null,
          width: width != null && Number.isFinite(width) && width > 0 ? width : null,
          height:
            height != null && Number.isFinite(height) && height > 0 ? height : null,
        });
      } catch {
        resolve({
          codec: null,
          formatName: null,
          duration: null,
          width: null,
          height: null,
        });
      }
    });
  });
}

export function runFfmpeg(args: string[]): Promise<void> {
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
