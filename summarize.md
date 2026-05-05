# Montaj — Session Summary

A beat-locked, AI-assisted Instagram-reel editor. Upload travel photos and clips, AI picks and orders them into a story, then drag a CapCut-style timeline at the bottom to refine. Live 9:16 preview with transitions, captions, and audio that loops to fit any 8–30 s reel length.

## What ships today

### Pipeline (end-user flow)

1. **Upload** — JPG, PNG, WebP, HEIC photos and MP4 / MOV / M4V clips. HEIC is converted to JPEG client-side; video duration is probed from metadata.
2. **Beat detection** — the browser decodes the chosen soundtrack via Web Audio, computes a 10-ms-hop energy onset envelope, and finds tempo by autocorrelation in the 70–180 BPM band. The beat grid is cached per track URL.
3. **AI selection** — clicking *Auto-pick & order* posts each photo (resized to 512 px JPEG) to `/api/analyze`. The route shells out to `scripts/analyze.sh`, which spawns `claude -p` with a strict JSON schema. Claude reads each photo via the `Read` tool, scores it (scene + qualityScore + caption), and returns a narrative `orderedIds` arc (hook → build → climax → outro). On failure (missing binary, schema mismatch, etc.) the route falls back to a heuristic ordering and surfaces the reason in the UI.
4. **Timeline rail** (CapCut-style, full-width, bottom of viewport) — one block per clip, width proportional to its beat count. Beat tick marks above the row mark every beat, with emerald markers + seconds labels every 4. A pink playhead tracks playback; clicking the rail seeks to that point.
5. **Edit** — drag the block header to reorder horizontally. Drag the left edge of a video to *front-trim* (`videoStartBeats` advances; right edge stays put in source time); drag the right edge to *tail-trim*. Snap is one beat (44 px). A 3-segment grey/green/grey filmstrip inside each video shows where the active range sits in the original clip.
6. **Auto-fit** — slider sets the target reel length 8–30 s; *Auto-fit* distributes target beats evenly across all clips, capped per-video by `floor(durationSeconds / beatPeriodSeconds)`.
7. **Preview** — Remotion Player at 1080 × 1920, 30 fps. Ken-Burns motion on photos, transitions cycling fade → slide → wipe between every slot, AI captions rendered as a centered overlay editable inline. Audio loops via Remotion's `<Loop>` so reels longer than the 24 s source keep playing without silence.

### Files of note

| File | Purpose |
|---|---|
| `src/components/montaj-week-one.tsx` | Main page. Owns timeline state, player ref, frame state, beat grid, AI status. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. |
| `src/components/slideshow-composition.tsx` | Remotion composition. Per-slot `startFrom` for video trim, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset + autocorrelation BPM detector, cached per track. |
| `src/lib/media.ts` | `TimelineMedia` type, 7-track music library, Supabase upload helper, HEIC/video handling. |
| `src/lib/photo-thumb.ts` | Canvas resize blob → 512 px JPEG data URL for AI calls. |
| `src/app/api/analyze/route.ts` | Decodes data URLs, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. |
| `scripts/analyze.sh` | `claude -p` headless wrapper with `--json-schema` and minimal `--system-prompt`. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at 92 / 100 / 112 / 128 BPM. |
| `public/music/*.wav` | Seven 24-s royalty-free demo loops. |

### Stack

Next.js 16 (App Router) · Tailwind 4 · TypeScript · Remotion 4.0.457 (`player` + `transitions`, both pinned) · `@dnd-kit/core` + `@dnd-kit/sortable` · `@supabase/supabase-js` (configured-or-fallback) · `heic-to`.

## Next steps (planned, ordered)

Detailed plans live in `montaj/CLAUDE.md` → "Next steps". Order matters:

1. **Fix the broken-video render** (blocker — must come before any new feature).
2. **Smart video trim** — `/api/trim-suggest` runs FFmpeg stability analysis on sampled frames + sends them to `claude -p` to pick the most beautiful, stable 1–2 s window per clip; result snaps to beats and sets `videoStartBeats` / `beats` automatically.
3. **AI picks reel timing** — extend `/api/analyze` to return `suggestedReelSeconds` (and optionally per-slot `slotBeats`) so *Auto-fit* matches content density instead of using a hand-set target.
4. **yt-dlp trending music** — paste a Reel / TikTok / Short URL → server-side `yt-dlp -x` → `ffmpeg -t` trim to reel length → add to library + re-run beat detection. TOS-aware (per the proposal); manual upload remains the fallback. Export is video-only when the source is fetched audio.
5. **Remaining Week 4** — MP4 export, NL refinement (`/api/refine`), vibe / mood selector, live Supabase + Clerk provisioning.

## Verification status

- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- `POST /api/analyze` returned 200 end-to-end with `source: "claude"` (~24 s round-trip on `haiku` for three placeholder photos).
- `GET /` returns 200; the page compiles via Turbopack.
- **Browser walkthrough not yet run end-to-end.** Playwright MCP is being installed next so the visual flow can be verified headless.
- **Open visual issue:** "broken video" reported after the front-trim refactor. Suspects and debug steps are listed in `montaj/CLAUDE.md`.

## Cost note

Each `/api/analyze` call writes ~30 K cache tokens because Claude Code still loads tool descriptions and plugin metadata even with `--system-prompt`. `--bare` would skip that but only works with `ANTHROPIC_API_KEY` auth, not the OAuth subscription. Acceptable for the demo (~$0.04 cold on `haiku`, much cheaper inside the 5-min cache window). For production, this would move to the Anthropic SDK directly.
