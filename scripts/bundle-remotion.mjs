// Bundle the Remotion composition into public/remotion-bundle so it's
// served as static assets alongside the rest of the app. The API route
// at /api/render-mp4 points its serveUrl at this directory.
import { bundle } from "@remotion/bundler";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.resolve(root, "src/remotion/index.ts");
const outDir = path.resolve(root, "public/remotion-bundle");
const publicDir = path.resolve(root, "public");

console.log("[remotion-bundle] entry:", entryPoint);
console.log("[remotion-bundle] outDir:", outDir);

const t0 = Date.now();
const bundleLocation = await bundle({
  entryPoint,
  publicDir,
  webpackOverride: (current) => ({
    ...current,
    resolve: {
      ...current.resolve,
      alias: {
        ...(current.resolve?.alias ?? {}),
        "@": path.resolve(root, "src"),
      },
    },
  }),
});
console.log("[remotion-bundle] bundled to temp:", bundleLocation);

await fs.rm(outDir, { recursive: true, force: true });
await fs.cp(bundleLocation, outDir, { recursive: true });
console.log(
  `[remotion-bundle] copied to ${outDir} (${((Date.now() - t0) / 1000).toFixed(
    1,
  )}s)`,
);
