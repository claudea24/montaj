import { auth } from "@clerk/nextjs/server";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { createClient } from "@supabase/supabase-js";
import chromium from "@sparticuz/chromium-min";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

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

    // If a service-role Supabase key is configured, upload the rendered
    // MP4 to storage and return a signed URL — that gives the browser a
    // native download flow with a proper filename and bypasses Vercel
    // response-size limits. Without service role we fall back to
    // streaming the file directly (works but the browser may strip the
    // .mp4 extension on save).
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const filename = `montaj-reel-${timestamp}.mp4`;

    if (serviceKey) {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        serviceKey,
        { auth: { persistSession: false } },
      );
      const storagePath = `${userId}/exports/${filename}`;
      const fileBuffer = await fs.readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from("montaj-media")
        .upload(storagePath, fileBuffer, {
          contentType: "video/mp4",
          upsert: false,
        });
      await fs.unlink(outputPath).catch(() => {});
      if (!uploadError) {
        const { data: signed } = await supabase.storage
          .from("montaj-media")
          .createSignedUrl(storagePath, 3600, { download: filename });
        if (signed?.signedUrl) {
          return new Response(
            JSON.stringify({ downloadUrl: signed.signedUrl, filename }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
      }
    }

    // Streaming fallback. Sets Content-Disposition with the timestamped
    // filename and inline Content-Length so the browser knows the full
    // size; streams from /tmp so Vercel's buffered-response cap doesn't
    // truncate it. Stream cleans up the temp file on close.
    const stat = await fs.stat(outputPath);
    const nodeStream = createReadStream(outputPath);
    nodeStream.on("close", () => {
      void fs.unlink(outputPath).catch(() => {});
    });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
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
