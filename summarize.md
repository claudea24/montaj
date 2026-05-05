# Montaj — Session Summary

A beat-locked, AI-assisted Instagram-reel editor. Upload travel photos and clips, AI picks and orders them into a story, then drag a CapCut-style timeline at the bottom to refine. Live 9:16 preview with transitions, captions, and audio that loops to fit any 8–30 s reel length.

## What ships today

### Pipeline (end-user flow)

1. **Upload** — JPG, PNG, WebP, HEIC photos and MP4 / MOV / M4V clips. HEIC is converted to JPEG client-side. Video uploads now pass through `POST /api/transcode-video` which probes the codec and, if it's HEVC (iPhone clips), pipes the file through `ffmpeg -c:v libx264 -vf scale=1280 -g 30 -keyint_min 30 -movflags +faststart`. H.264 inputs get a 204 and stay untouched. Duration is probed from the resulting blob URL.
2. **Beat detection** — the browser decodes the chosen soundtrack via Web Audio, computes a 10-ms-hop energy onset envelope, and finds tempo by autocorrelation in the 70–180 BPM band. The beat grid is cached per track URL.
3. **AI selection** — clicking *Auto-pick & order* posts each photo (resized to 512 px JPEG) to `/api/analyze`. The route shells out to `scripts/analyze.sh`, which spawns `claude -p` with a strict JSON schema. Claude reads each photo via the `Read` tool, scores it (scene + qualityScore + caption), and returns a narrative `orderedIds` arc (hook → build → climax → outro). On failure (missing binary, schema mismatch, etc.) the route falls back to a heuristic ordering and surfaces the reason in the UI.
4. **Timeline rail** (CapCut-style, full-width, bottom of viewport) — one block per clip, width proportional to its beat count. Beat tick marks above the row mark every beat, with emerald markers + seconds labels every 4. A pink playhead tracks playback; clicking the rail seeks to that point. Total seconds and the playhead position both account for `TransitionSeries` overlap so the rail stays aligned with the player.
5. **Edit** — drag the block header to reorder horizontally. Drag the left edge of a video to *front-trim* (`videoStartBeats` advances; right edge stays put in source time); drag the right edge to *tail-trim*. Snap is one beat (44 px). A 3-segment grey/green/grey filmstrip inside each video shows where the active range sits in the original clip.
6. **Auto-fit** — slider sets the target reel length 8–30 s; *Auto-fit* distributes target beats evenly across all clips, capped per-video by `floor(durationSeconds / beatPeriodSeconds)`.
7. **Preview** — Remotion Player at 1080 × 1920, 30 fps. Ken-Burns motion on photos, transitions cycling fade → slide → wipe between every slot, AI captions rendered as a centered overlay editable inline. Audio loops via Remotion's `<Loop>` so reels longer than the 24 s source keep playing without silence. The composition uses `<Video>` (not `OffthreadVideo`) with `pauseWhenBuffering={false}` and `acceptableTimeShiftInSeconds={10}` for smoother native playback.

### Files of note

| File | Purpose |
|---|---|
| `src/components/montaj-week-one.tsx` | Main page. Owns timeline state, player ref, frame state, beat grid, AI status. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. Now consumes `transitionFrames` and computes per-slot player-start frames. |
| `src/components/slideshow-composition.tsx` | Remotion composition. `<Video>` slots, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset + autocorrelation BPM detector, cached per track. |
| `src/lib/media.ts` | `TimelineMedia` type, 7-track music library, Supabase upload helper, HEIC handling, **`transcodeIfHevc`** helper that posts video uploads to `/api/transcode-video`. |
| `src/lib/photo-thumb.ts` | Canvas resize blob → 512 px JPEG data URL for AI calls. |
| `src/app/api/analyze/route.ts` | Decodes data URLs, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. |
| `src/app/api/transcode-video/route.ts` | **New.** Streams uploads to `/tmp`, ffprobes codec, returns 204 if H.264, otherwise transcodes via `spawn('ffmpeg', …)` and returns `video/mp4`. 250 MB cap, 120 s `maxDuration`. |
| `scripts/analyze.sh` | `claude -p` headless wrapper with `--json-schema` and minimal `--system-prompt`. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at 92 / 100 / 112 / 128 BPM. |
| `public/music/*.wav` | Seven 24-s royalty-free demo loops. |

### Stack

Next.js 16 (App Router) · Tailwind 4 · TypeScript · Remotion 4.0.457 (`player` + `transitions`, both pinned) · `@dnd-kit/core` + `@dnd-kit/sortable` · `@supabase/supabase-js` (configured-or-fallback) · `heic-to`. Server-side `ffmpeg` and `ffprobe` (Homebrew install on macOS) for HEVC transcode.

## Updates made this session

Six discrete fixes/features landed. Order matters because each unblocked the next.

1. **Broken-video render after the front-trim refactor** — `slideshow-composition.tsx` was passing `startFrom={0}` unconditionally to `OffthreadVideo`. Per `node_modules/remotion/dist/cjs/video/OffthreadVideo.js`, any defined `startFrom` (even 0) wraps the video in an extra `<Sequence layout="none" from={0}>`, which interacts badly with `TransitionSeries.Sequence`. Fix: only pass `trimBefore` when `videoStartBeats > 0`. Verified end-to-end with Playwright — both untrimmed and trimmed cases render correctly.
2. **Timeline rail / player misalignment** — the rail walked `perSlotFrames` cumulatively, but the player walks the `TransitionSeries` (which subtracts overlaps). With 7 transitions × 12 frames, rail "Total" was ~2.8 s longer than the player's actual reel and the playhead lagged behind the visible scene. Fix in `timeline-rail.tsx`: new `transitionFrames` prop (passed through from `montaj-week-one.tsx`), `totalSeconds = totalDurationFrames / fps`, new `perSlotPlayerStartFrames` memo applying the same overlap formula the parent uses, and both `playheadPx` + `handleRailClick` consume those start frames.
3. **`OffthreadVideo` → `<Video>` for player smoothness** — `OffthreadVideo` in player mode seeks the underlying `<video>.currentTime` every frame, which stalls on long-keyframe-interval clips. Switched to `<Video>` (native playback) with `pauseWhenBuffering={false}` and `acceptableTimeShiftInSeconds={10}` so Remotion stops aggressively re-syncing.
4. **HEVC → H.264 transcode on upload** — new `src/app/api/transcode-video/route.ts`. Streams the uploaded file to a temp dir via `pipeline(Readable.fromWeb(file.stream()), createWriteStream(...))` (avoids buffering the whole blob into JS memory), ffprobes the codec, and either returns 204 unchanged for H.264 or transcodes HEVC with `ffmpeg -c:v libx264 -preset veryfast -crf 23 -vf scale=w=1280:h=1280:force_original_aspect_ratio=decrease -r 30 -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart`. Client side: `transcodeIfHevc` wraps the response into a fresh `File` and the rest of `prepareFile` continues unchanged. ~7 s wall time for a 20 s 1080p iPhone clip on an Apple Silicon box.
5. **Tail static frame gone** — `durationInFrames = Math.max(totalFrames, FPS * 5)` padded short reels with a held-still frame after the last slot ended. Now `durationInFrames = timeline.length === 0 ? FPS * 5 : Math.max(totalFrames, 1)`, so the reel ends exactly when the last slot ends.
6. **1-second keyframes on transcoded preview** — added `-g 30 -keyint_min 30 -sc_threshold 0` so any trim offset is at most one second from a keyframe. Verified via ffprobe: 5 keyframes at 0/1/2/3/4 s in a 4.23 s clip.

### Verification

- `npx tsc --noEmit` clean after every change.
- Playwright walkthrough at http://localhost:3737:
  - Untrimmed video clip — renders correctly, no broken frame.
  - Trim drag → trimmed video plays from offset, head/tail labels show correct seconds.
  - 8-clip reel: rail "Total 29.2 s" matches player "0:29"; clicks at 10 / 30 / 50 / 75 / 95 % land at 3.27 / 8.87 / 14.40 / 21.60 / 27.67 s in the player; playhead at 16.40 s sits on clip #5 while the player renders scene "05".
  - 3 HEVC iPhone clips upload → transcode round-trip → playback in the player with no console errors. Returned `x-transcoded: 1` header confirmed via curl on `/api/transcode-video`.

### Known unresolved problem

**Trim still stutters on iPhone-sourced clips.** After all six fixes above, the user reports stutter returns when a clip is shortened (left-edge front-trim). The transcoded mp4 is now 720×1280 H.264 with a keyframe every second — a small, decoder-friendly file — yet visible stalls remain when the player starts a slot at a non-zero `trimBefore`. Hypotheses to chase next session, in order of cheapest to try:

1. **Cap preview to 480 p / lower the bitrate.** Replace the scale filter with `scale=w=720:h=720:force_original_aspect_ratio=decrease` and bump `-crf` to 28. Gives a tiny preview file, may fully eliminate decode latency on Chrome/macOS.
2. **Force `-r 24` and `-tune fastdecode`.** Reduces decode work per second.
3. **Check `<Video>` premount behavior in `TransitionSeries`.** Each transition mounts the next clip ahead of time, which means the underlying `<video>` does its first seek-to-`trimBefore` while the previous slot is still rendering. If the seek itself is what stalls, premounting earlier (or pre-warming via `preload="auto"` on a hidden tag at upload time) could absorb the cost.
4. **Try `OffthreadVideo` with the new short-keyframe transcode.** I switched away because it seek-per-frame stalled on 1080p HEVC; on a 720p H.264 file with 1 s keyframes the math may flip and `OffthreadVideo`'s deterministic frame-pull becomes faster than the native pipeline.
5. **Pre-extract frames on upload.** Last resort: `ffmpeg -vf fps=30 frame-%04d.jpg` and feed an `<Img>` sequence into the player. Slower upload, perfect playback, perfect render parity. Probably overkill.

The audio loop seam is also slightly audible at 24 s on short reels but the user accepted it; long-track support would dilute the issue.

## Next steps (planned, ordered)

Detailed plans live in `montaj/CLAUDE.md` → "Next steps". Order matters:

1. **Trim-stutter on HEVC clips** (current blocker — must come before any new feature). Try the hypotheses above.
2. **Smart video trim** — `/api/trim-suggest` runs FFmpeg stability analysis on sampled frames + sends them to `claude -p` to pick the most beautiful, stable 1–2 s window per clip; result snaps to beats and sets `videoStartBeats` / `beats` automatically.
3. **AI picks reel timing** — extend `/api/analyze` to return `suggestedReelSeconds` (and optionally per-slot `slotBeats`) so *Auto-fit* matches content density instead of using a hand-set target.
4. **yt-dlp trending music** — paste a Reel / TikTok / Short URL → server-side `yt-dlp -x` → `ffmpeg -t` trim to reel length → add to library + re-run beat detection. TOS-aware (per the proposal); manual upload remains the fallback. Export is video-only when the source is fetched audio.
5. **Remaining Week 4** — MP4 export, NL refinement (`/api/refine`), vibe / mood selector, live Supabase + Clerk provisioning.

## Cost note

Each `/api/analyze` call writes ~30 K cache tokens because Claude Code still loads tool descriptions and plugin metadata even with `--system-prompt`. `--bare` would skip that but only works with `ANTHROPIC_API_KEY` auth, not the OAuth subscription. Acceptable for the demo (~$0.04 cold on `haiku`, much cheaper inside the 5-min cache window). For production, this would move to the Anthropic SDK directly.

`/api/transcode-video` is local-only (server-side `ffmpeg`, no model calls). Cost is wall-clock CPU during the upload window.
