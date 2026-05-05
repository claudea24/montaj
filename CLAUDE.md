# Montaj — Notes for Claude Code

Project-scoped notes. The repo-root `CLAUDE.md` (one directory up) covers global security and Supabase MCP setup; this file is montaj-specific.

## Repo facts

- **Framework:** Next.js 16 App Router, Tailwind 4, TypeScript.
- **Video engine:** Remotion 4.0.457 — `remotion`, `@remotion/player`, `@remotion/transitions` are all pinned to that minor. Do not bump only one of them; that produces two parallel `remotion` packages and breaks the player context at runtime.
- **AI selection:** runs through `scripts/analyze.sh`, which spawns `claude -p` headless with `--system-prompt`, `--json-schema`, `--allowedTools Read`, and `--dangerously-skip-permissions`. The Next.js route at `src/app/api/analyze/route.ts` decodes incoming data URLs to a temp dir, spawns the bash script, and parses `structured_output`. There is no OpenAI dependency.
- **Music tracks:** seven 24-s loops in `public/music/*.wav`. Regenerate with `node scripts/gen-music.mjs` (procedural kick + pad + hat synth at four BPMs).
- **Dev server:** `PORT=3737 npm run dev`. Type-check / lint: `npx tsc --noEmit && npm run lint`.

## Conventions

- **Beat math:** `beatPeriodSeconds = 60 / bpm`. Reel total = sum(beats × beatPeriodSeconds × fps) − sum(transition overlap frames). Transition overlap = `min(prevSlotFrames/2, nextSlotFrames/2, 12)`.
- **Per-clip state:** every `TimelineMedia` carries `beats`. Videos additionally carry `videoStartBeats` (head trim). The cap is `floor(durationSeconds / beatPeriodSeconds)`. The `setTrim(id, startBeats, beats)` handler is the single source of truth — don't update `beats` and `videoStartBeats` separately.
- **8–30 s reel clamp** lives in `montaj-week-one.tsx` (constants `MIN_REEL_SECONDS`, `MAX_REEL_SECONDS`) and `timeline-rail.tsx` (UI warnings + `+1b` disable when over).
- **Pixel↔beat:** `PX_PER_BEAT = 44` in `timeline-rail.tsx`. Same constant is used for clip widths, beat tick spacing, click-to-seek mapping, and drag-snap thresholds.
- **Transitions:** use `TransitionSeries` from `@remotion/transitions`, not raw `Sequence`s. Cycle is fade → slide → wipe.
- **Audio:** wrap `Html5Audio` in Remotion's `<Loop>` with `durationInFrames = MUSIC_LENGTH_SECONDS × fps` so reels longer than 24 s don't go silent.

## Active issue

**"Broken video" rendering** reported after the front-trim refactor. Investigation steps:

1. Drive the page via Playwright (either install the Playwright MCP — `claude mcp add playwright -- npx @playwright/mcp@latest` then restart Claude Code — or add `@playwright/test` as a devDep here). Drop a real ≥4-s clip and screenshot the result.
2. **Suspect 1: `OffthreadVideo startFrom`.** The current code passes `startFrom={0}` for un-trimmed videos. `startFrom` is a deprecated alias for `trimBefore`; `startFrom={0}` *should* be a no-op but may warn or behave oddly. Try: only pass the prop when `videoStartBeats > 0`, and rename to `trimBefore` for clarity.
3. **Suspect 2: the ghost filmstrip in `timeline-rail.tsx`.** If only the rail thumbnail looks broken (not the preview), the new 3-segment bar's flex/percent math may be off when `videoStartBeats === 0` (head segment width 0 % can collapse). Check `headPct + activePct ≤ 100`.
4. **Suspect 3: stale `beats` from before the floor() change.** A previous session may have stored `beats > maxBeats` (we used `round()` then). On reload state is empty, but if HMR persisted state during my refactor that could be it. Reload the page fresh to rule out.

## Next steps (ordered)

Do them in this order — earlier steps reduce risk for later ones, and the broken-video fix has to come before any new feature lands or we'll be debugging two regressions instead of one.

### 1. Fix the broken-video render (blocker)

See "Active issue" above. Walk the page in Playwright, screenshot, and follow suspects 1–3.

### 2. Smart video trim — AI picks the right window

**Goal:** for each uploaded video, automatically choose `videoStartBeats` and `beats` so the active range lands on the stable, scenic part instead of camera shake or transitions.

**Approach (lightweight, no new model deploy):**
- Server route `POST /api/trim-suggest` accepts `{ videoPath, durationSeconds, beatPeriodSeconds, maxReelSeconds }`.
- On the server, run `ffmpeg` to:
  - Sample ~8 frames evenly across the clip → tiny JPEGs in a temp dir.
  - Compute a **stability score per window** via `ffmpeg -vf "select='gt(scene,0.3)'"` (scene-cut count) and a basic motion magnitude via `ffmpeg -vf vidstabdetect` (or just inter-frame diff via the `bmovie` / `tblend` filter — pick whichever ships with the system FFmpeg).
- Send the 8 sampled frames to `claude -p` (reuse `scripts/analyze.sh` pattern, new prompt) asking: "Which 1–2 second window shows the most beautiful, stable scenery? Return `{ startSeconds, endSeconds }`."
- Combine: stability score gates "is this window even watchable", AI vision picks "is this window beautiful". Pick the highest combined score, snap to beats, set `videoStartBeats` and `beats`.
- **Files to touch:**
  - new `src/app/api/trim-suggest/route.ts`
  - new `scripts/trim-suggest.sh` (analogous to `scripts/analyze.sh`)
  - `src/components/montaj-week-one.tsx` — add a "Smart trim" button per video clip, or auto-call after upload
  - `src/lib/ai.ts` — add `TrimSuggestion` type
- **Gotchas:**
  - ffmpeg must be on `PATH` server-side; surface a clear error in the UI if missing.
  - HEVC / H.265 mp4s from iPhones may need `ffmpeg -c:v libx264` re-encode before frame extraction; do this lazily.
  - Cap input video size — refuse anything > 200 MB to keep temp dirs sane.
  - Don't block upload on trim suggestion — run it as a background `Promise` and patch `videoStartBeats` / `beats` when it returns.

### 3. AI picks reel timing — music length matched to content

**Goal:** instead of the user setting a 8–30 s target by hand, the *Auto-fit* button asks AI for the right length given the clip count, content, and music BPM.

**Approach:**
- Extend `/api/analyze`'s response with `suggestedReelSeconds: number`. The prompt already knows clip count and scene tags; add a sentence: "Suggest a reel length 8–30 s, biased toward 12 s for ≤6 clips, 18 s for 7–10 clips, 25 s for >10 clips, but bend it for the content."
- After analysis, set `targetSeconds = result.suggestedReelSeconds` and invoke `autoFit()`.
- Optionally: also ask the AI for a per-clip beat suggestion (returns `slotBeats: number[]`) so high-impact moments (climax, sunset) get more beats than filler. This biases away from `Auto-fit`'s uniform distribution.
- **Files to touch:** `scripts/analyze.sh` (prompt + JSON schema), `src/app/api/analyze/route.ts` (response shape), `src/lib/ai.ts` (`AnalysisResult`), `src/components/montaj-week-one.tsx` (apply suggestion).
- **Gotcha:** keep `targetSeconds` user-editable after the suggestion lands — don't lock the slider.

### 4. yt-dlp trending music — paste a URL, fit it to the reel

**Goal:** user pastes a reel / TikTok / YouTube Short URL → the audio is fetched, beat-detected, and trimmed to match the current reel length.

**Approach:**
- Server route `POST /api/fetch-audio` accepts `{ url }` and returns `{ audioPath, durationSeconds, originalUrl }`.
- Spawn `yt-dlp -x --audio-format wav -o /tmp/montaj-audio/<uuid>.wav <url>`.
- Probe duration (`ffprobe`), respond with the file path. Move it under `public/music/fetched/` so the existing `<audio>` element can play it without auth.
- New UI section in the Soundtrack panel: "Paste a URL". Show a TOS-aware warning per the proposal (yt-dlp violates platform ToS; the fetched audio is used for beat detection / preview only and never embedded in the export). Fall back to a manual file upload control if the fetch fails.
- After fetch:
  - Add the track to `MUSIC_LIBRARY` in memory (not on disk persistently — clean up on page reload or via a periodic cron in `/tmp`).
  - Re-run `detectBeats(track.src)` to populate the beat grid.
  - Optionally trim the audio to `reelTotalSeconds` via `ffmpeg -t` so the loop boundary lands cleanly.
- **Files to touch:**
  - new `src/app/api/fetch-audio/route.ts`
  - `src/lib/media.ts` — extend `MusicTrack` with `originalUrl` + a "fetched" flag for UI distinction
  - `src/components/montaj-week-one.tsx` — URL input + paste handler in the Soundtrack section
- **Gotchas:**
  - `yt-dlp` must be on `PATH`; document install in this file (`brew install yt-dlp` on macOS).
  - Some platforms (TikTok especially) periodically break yt-dlp; expect failures, surface them clearly, keep manual upload as the fallback.
  - Don't persist downloaded audio in git or a CDN — it's stored under `/tmp` or `public/music/fetched/` (gitignored).
  - Export must be **video-only** when the source is fetched audio (per Option A of the proposal). Tag the track with a flag and skip embedding in render.

### 5. Remaining Week 4 work

- **MP4 export** — Remotion `@remotion/renderer` server route, with a "video-only" branch when the soundtrack is yt-dlp-fetched.
- **Natural-language AI refinement** — "make the intro faster", "swap clip 3 for a wider shot". Single `/api/refine` endpoint that takes the current timeline + a prompt and returns a patch (reorders, beat changes, swaps).
- **Vibe / mood selector** — text → biases AI selection prompts (`scripts/analyze.sh`) and editing pace.
- **Live Supabase + Clerk provisioning** — wire to a real project so uploads persist per user. The repo-root `CLAUDE.md` already documents the Clerk-Supabase native integration pattern.

## Verification commands

```bash
# Type-check and lint
npx tsc --noEmit && npm run lint

# Smoke the AI route headless (skips Next.js entirely)
mkdir -p tmp-demo/upscaled
sips -Z 512 tmp-demo/beach.png --out tmp-demo/upscaled/beach.png
MAX_PICKS=3 CLAUDE_MODEL=haiku scripts/analyze.sh \
  "id=beach:$PWD/tmp-demo/upscaled/beach.png"

# End-to-end via the API route (requires dev server running)
curl -s -X POST -H "Content-Type: application/json" \
  --data @/tmp/montaj-body.json http://localhost:3737/api/analyze
```

## File map

| File | Purpose |
|---|---|
| `src/components/montaj-week-one.tsx` | Main page; owns `timeline`, `selectedTrack`, `beatGrid`, `currentFrame`. Holds `playerRef`. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. |
| `src/components/slideshow-composition.tsx` | Remotion composition. Per-slot `startFrom` for video front-trim, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset envelope + autocorrelation BPM. Cached per-track. |
| `src/lib/media.ts` | `TimelineMedia` type, music library, Supabase upload helper, HEIC + video probe. |
| `src/app/api/analyze/route.ts` | Decodes data URLs to temp dir, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. |
| `scripts/analyze.sh` | `claude -p` wrapper with strict JSON schema. Prints `structured_output`; exit 4 if absent. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at four BPMs. |
