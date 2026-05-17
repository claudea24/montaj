import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The bundled ffmpeg/ffprobe binaries live in platform-specific subfolders
  // (e.g. linux-x64 on Vercel). Next.js's default file tracer sometimes
  // misses these because they're resolved at runtime via `require`. Force
  // them into the function bundle so the transcode route can spawn them.
  outputFileTracingIncludes: {
    "/api/transcode-video": [
      "./node_modules/@ffmpeg-installer/**/*",
      "./node_modules/@ffprobe-installer/**/*",
    ],
  },
};

export default nextConfig;
