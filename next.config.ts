import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allow running a second `next dev` (e.g., a test instance) in parallel
  // with the primary one by overriding the output dir via env. Default `.next`
  // matches Next.js's own default.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Keep the installer packages out of Turbopack's bundle graph. They load
  // platform-specific subfolders via runtime `require` and ship non-JS files
  // (READMEs, binaries) that Turbopack can't classify.
  serverExternalPackages: [
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
    "@remotion/renderer",
    "@sparticuz/chromium-min",
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
    "/api/render-mp4": [
      "./node_modules/@remotion/renderer/**/*",
      "./node_modules/@sparticuz/chromium-min/**/*",
      "./node_modules/@ffmpeg-installer/**/*",
    ],
  },
};

export default nextConfig;
