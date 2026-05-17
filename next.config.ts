import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the installer packages out of Turbopack's bundle graph. They load
  // platform-specific subfolders via runtime `require` and ship non-JS files
  // (READMEs, binaries) that Turbopack can't classify.
  serverExternalPackages: [
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
  ],
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
