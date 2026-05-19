import { renderMedia, selectComposition } from "@remotion/renderer";
import chromium from "@sparticuz/chromium-min";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

const CHROMIUM_TAR =
  "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar";

function getServeUrl(req: Request): string {
  // The composition was pre-bundled at build time into /public/remotion-bundle/.
  // Remotion's serveUrl can be either a file path (locally) or an HTTP URL
  // (deployment). Both work; URL is reliable on serverless.
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/remotion-bundle`;
  }
  // Use the incoming request's origin so local dev (any port) works.
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}/remotion-bundle`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const inputProps = body?.inputProps;
    if (!inputProps) {
      return new Response(
        JSON.stringify({ error: "missing inputProps" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const serveUrl = getServeUrl(req);

    const isVercel = Boolean(process.env.VERCEL);
    const browserExecutable = isVercel
      ? await chromium.executablePath(CHROMIUM_TAR)
      : undefined;

    const composition = await selectComposition({
      serveUrl,
      id: "Slideshow",
      inputProps,
      browserExecutable,
    });

    const outputPath = path.join("/tmp", `render-${Date.now()}.mp4`);
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      browserExecutable,
      chromiumOptions: isVercel ? { gl: "angle" } : undefined,
      // Bump delayRender() timeout — slow Supabase signed URLs can stall video
      // loading past the default 30s.
      timeoutInMilliseconds: 90_000,
      // Force broadly-compatible pixel format. Default yuvj420p (full range)
      // is rejected by QuickTime/Safari and some embedded players.
      pixelFormat: "yuv420p",
    });

    const file = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});

    return new Response(file as unknown as BodyInit, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="montaj-reel.mp4"',
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
