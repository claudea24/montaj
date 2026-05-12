# Montaj — Notes for Claude Code

Project-scoped notes. The repo-root `CLAUDE.md` (one directory up) covers global security and Supabase MCP setup; this file is montaj-specific.

## Resume here — backend setup in progress (paused 2026-05-12)

**Where we paused:** Step 1 of the 4-step backend setup (see "Backend setup plan" below). Waiting on the user to provision a Supabase project and register the MCP locally.

**What the user is doing offline:**
1. Create new Supabase project at https://supabase.com/dashboard/new (name `montaj`).
2. Copy the project ref (the 20-char segment in `dashboard/project/<REF>` or **Project Settings → General → Reference ID**).
3. Run `claude mcp add supabase --transport http "https://mcp.supabase.com/mcp?project_ref=<REF>"`, then `/exit` and re-launch `claude` from `/Users/claudea/projects/montaj` so the supabase MCP tools load.
4. From **Project Settings → API**, copy **Project URL** and **anon public** key into `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   NEXT_PUBLIC_SUPABASE_BUCKET=montaj-media
   ```
5. Verify `.gitignore` covers `.env.local` (it should — never read or commit env files; see repo-root `CLAUDE.md` security rules).

**What I do when they return and say "step 1 done":**
1. `claude mcp list | grep supabase` — confirm the MCP is registered.
2. Call `mcp__supabase__authenticate` and complete the auth flow if needed.
3. Verify access: list buckets, list `auth.users` table, list public schema — all should respond without errors.
4. Once verified, mark Task #23 complete and start Task #24 (Step 2 — Clerk).

**Do not start Step 2 (Clerk) or Step 4 (Vercel) until Step 1 is verified working.** The user was explicit about this ordering — see the "Backend Setup Requirements" message they sent.

## Backend setup plan (4 ordered steps)

The user pinned this ordering. Don't reorder.

### Step 1 — Supabase MCP (in progress, see Resume here above)

Goal: Claude can read schema, storage buckets, auth tables, and project env vars via the Supabase MCP. Project credentials wired into `.env.local`.

### Step 2 — Clerk auth (blocked on Step 1)

Goal: Clerk + native Supabase third-party-auth integration (April 2025 pattern; **NOT** the deprecated JWT-template approach). The repo-root `CLAUDE.md` has the exact dashboard setup steps and client/server code patterns — follow those.

- Dashboard wiring: Clerk **Activate Supabase integration** → copy Clerk domain → Supabase **Authentication > Sign In/Up → Add provider → Clerk** → paste domain.
- Auth features: email/password sign-in, Google OAuth, persistent sessions, route protection via Clerk middleware.
- RLS policies use `(select auth.jwt()->>'sub') = (user_id)::text` with `to authenticated`.
- Code: replace the unauthed Supabase client in `src/lib/media.ts` with one that calls `session.getToken()` for `accessToken` (client-side) and `(await auth()).getToken()` (server-side).
- Each user gets isolated access via RLS — no app-level filtering on `user_id` should be needed once policies are in place.

### Step 3 — Project + storage schema (blocked on Step 2)

Goal: auto-saved per-user projects with media + timeline state.

Tables (all with RLS `user_id = auth.jwt()->>'sub'`, `to authenticated`):
- `profiles` — Clerk user id, display name, created_at.
- `projects` — id, owner, title, status (draft|finalized), updated_at, target_seconds, selected_track_id.
- `assets` — id, project_id, kind (image|video), src (storage path), duration_seconds, name, size.
- `timelines` — id, project_id, slots jsonb (`[{asset_id, beats, video_start_beats, caption}]`), revision.
- `exports` — id, project_id, status, output_url, started_at, finished_at.

Storage buckets:
- `montaj-media` (already in `.env.example`) — raw uploads.
- `montaj-exports` — rendered MP4s.

Auto-save: debounced `setTimeline` writes a new `timelines` row (or updates the latest, depending on whether we want revision history). Recommend keeping the last 5 revisions per project so users can recover drafts.

### Step 4 — Vercel deploy (blocked on Step 3)

Only deploy after the local app works end-to-end with auth + persistence.

- Env vars in Vercel dashboard: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_BUCKET`, Clerk publishable + secret keys.
- ffmpeg routes (`/api/transcode-video`) need bumped memory + `maxDuration` (already 120s in code). Confirm Vercel Pro plan limits accommodate.
- 250 MB upload cap stays. For larger files use direct-to-Supabase-Storage uploads with signed URLs (skip the Next.js route entirely).
- Verify HEVC transcode works on Vercel's Linux: Vercel doesn't ship ffmpeg by default — use `@ffmpeg-installer/ffmpeg` as a dep or switch to Vercel's image of choice (or move transcode to a Supabase Edge Function / external worker).

## Repo facts

- **Framework:** Next.js 16 App Router, Tailwind 4, TypeScript.
- **Video engine:** Remotion 4.0.457 — `remotion`, `@remotion/player`, `@remotion/transitions` are all pinned to that minor. Do not bump only one of them; that produces two parallel `remotion` packages and breaks the player context at runtime.
- **AI selection:** runs through `scripts/analyze.sh`, which spawns `claude -p` headless with `--system-prompt`, `--json-schema`, `--allowedTools Read`, and `--dangerously-skip-permissions`. The Next.js route at `src/app/api/analyze/route.ts` decodes incoming data URLs to a temp dir, spawns the bash script, and parses `structured_output`. There is no OpenAI dependency.
- **HEVC transcode:** every video upload posts to `POST /api/transcode-video`. The route streams the file to `/tmp/montaj-transcode-*`, ffprobes it, returns `204 No Content` for H.264 inputs, and otherwise transcodes via `ffmpeg -c:v libx264 -vf scale=1280 -r 30 -crf 23 -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart -c:a aac`. Server-side `ffmpeg` + `ffprobe` must be on `PATH` (`brew install ffmpeg` on macOS). 250 MB input cap; 120 s `maxDuration`.
- **Music tracks:** seven 24-s loops in `public/music/*.wav`. Regenerate with `node scripts/gen-music.mjs` (procedural kick + pad + hat synth at four BPMs).
- **Dev server:** `PORT=3737 npm run dev`. Type-check / lint: `npx tsc --noEmit && npm run lint`.

## Conventions

- **Beat math:** `beatPeriodSeconds = 60 / bpm`. Reel total = `sum(perSlotFrames) − sum(transitionOverlaps)`. Transition overlap = `max(2, min(prevSlotFrames/2, nextSlotFrames/2, TRANSITION_FRAMES))`.
- **Per-clip state:** every `TimelineMedia` carries `beats`. Videos additionally carry `videoStartBeats` (head trim). The cap is `floor(durationSeconds / beatPeriodSeconds)`. The `setTrim(id, startBeats, beats)` handler is the single source of truth — don't update `beats` and `videoStartBeats` separately.
- **Player composition length:** `durationInFrames = timeline.length === 0 ? FPS * 5 : Math.max(totalFrames, 1)`. Don't pad with `Math.max(totalFrames, FPS * 5)` — that re-introduces the static-tail-frame bug at end of short reels.
- **Rail/player alignment:** the rail receives `transitionFrames` and re-derives `perSlotPlayerStartFrames` using the same overlap formula. `totalSeconds` is read from `totalDurationFrames / fps`, never from raw beats × beat-period (those don't subtract overlaps).
- **8–30 s reel clamp** lives in `montaj-week-one.tsx` (constants `MIN_REEL_SECONDS`, `MAX_REEL_SECONDS`) and `timeline-rail.tsx` (UI warnings + `+1b` disable when over).
- **Pixel↔beat:** `PX_PER_BEAT = 44` in `timeline-rail.tsx`. Same constant is used for clip widths, beat tick spacing, click-to-seek mapping, and drag-snap thresholds.
- **Transitions:** use `TransitionSeries` from `@remotion/transitions`, not raw `Sequence`s. Cycle is fade → slide → wipe.
- **Video element:** `<Video>` (not `OffthreadVideo`) inside the slot, with `pauseWhenBuffering={false}` and `acceptableTimeShiftInSeconds={10}`. Pass `trimBefore={startFrom}` only when `startFrom > 0` — passing a defined `0` makes Remotion wrap the video in an extra `<Sequence layout="none">` that interacts badly with `TransitionSeries`.
- **Audio:** wrap `Html5Audio` in Remotion's `<Loop>` with `durationInFrames = MUSIC_LENGTH_SECONDS × fps` so reels longer than 24 s don't go silent.

## Active issue

None currently. **Trim stutter on HEVC clips** is fully resolved. The slot now uses a plain `<Video>` with `trimBefore` for both trimmed and untrimmed clips, with no preview-frame fallback. Root cause was a competition for the video-decode pipeline: an in-browser preview-frame extractor (a hidden `<video>` cycling through 180 seek-decode-canvas operations) ran in parallel with the Remotion Player's native `<Video>`. Both fed off the same decoder, and the player visibly stalled.

Resolution (in order applied):
1. Switched the preview-frame `<Img>` sequence to a native `<img>` — Remotion's `<Img>` calls `delayRender()` on every `src` change, which froze the Player when preview frames swapped at ~8 fps inside a 30 fps Player. That got the Img path advancing but at half quality.
2. Tested whether native `<Video trimBefore>` would now run smoothly with no preview-frame extractor running in parallel — yes. 63% real-time rate in headless Chrome (matches the no-trim baseline of 59% in the same environment), zero stalls. Real browsers with GPU should hit 100%.
3. Deleted the entire preview-frame path: `extractVideoPreviewFrames` and its types in `src/lib/media.ts`, the eager-extraction `useEffect` in `montaj-week-one.tsx`, and the `<img>` branch in `slideshow-composition.tsx`. Slot now always renders `<Video src trimBefore?>` at full source quality.

Reproduction (kept for regression testing): `tmp-demo/hevc/IMG_1801.MOV` (20 s, 1920×1080, HEVC, AAC). Drag the clip from the library list onto the rail, drag left edge to set head-trim ~3 s, click play. Playhead advances at real-time speed at full 720 p H.264 quality (the transcoded preview).

A secondary minor issue: the soundtrack loop seam at 24 s is faintly audible on short reels. The user accepted it for now; longer tracks dilute it. Crossfading the loop point in `scripts/gen-music.mjs` is a one-bar fix when desired.

## Next steps (ordered)

Do them in this order — earlier steps reduce risk for later ones, and the trim-stutter fix has to come before any new feature lands or we'll be debugging two regressions instead of one.

### 1. Smart video trim — AI picks the right window

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
  - ffmpeg is already required for `/api/transcode-video`; no new dependency.
  - For HEVC inputs, sample frames from the *transcoded* H.264 file, not the original — the transcode route already produced one and the path could be passed through.
  - Cap input video size — refuse anything > 200 MB to keep temp dirs sane (mirrors the transcode cap of 250 MB).
  - Don't block upload on trim suggestion — run it as a background `Promise` and patch `videoStartBeats` / `beats` when it returns.

### 2. AI picks reel timing — music length matched to content

**Goal:** instead of the user setting a 8–30 s target by hand, the *Auto-fit* button asks AI for the right length given the clip count, content, and music BPM.

**Approach:**
- Extend `/api/analyze`'s response with `suggestedReelSeconds: number`. The prompt already knows clip count and scene tags; add a sentence: "Suggest a reel length 8–30 s, biased toward 12 s for ≤6 clips, 18 s for 7–10 clips, 25 s for >10 clips, but bend it for the content."
- After analysis, set `targetSeconds = result.suggestedReelSeconds` and invoke `autoFit()`.
- Optionally: also ask the AI for a per-clip beat suggestion (returns `slotBeats: number[]`) so high-impact moments (climax, sunset) get more beats than filler. This biases away from `Auto-fit`'s uniform distribution.
- **Files to touch:** `scripts/analyze.sh` (prompt + JSON schema), `src/app/api/analyze/route.ts` (response shape), `src/lib/ai.ts` (`AnalysisResult`), `src/components/montaj-week-one.tsx` (apply suggestion).
- **Gotcha:** keep `targetSeconds` user-editable after the suggestion lands — don't lock the slider.

### 3. yt-dlp trending music — paste a URL, fit it to the reel

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

### 4. Remaining Week 4 work

- **MP4 export** — Remotion `@remotion/renderer` server route, with a "video-only" branch when the soundtrack is yt-dlp-fetched. Note: the slot uses `<Video>` for preview smoothness; renderer mode honors that, but if fidelity issues appear, swapping to `<OffthreadVideo>` for render only (via `getRemotionEnvironment().isRendering`) is a documented escape hatch.
- **Natural-language AI refinement** — "make the intro faster", "swap clip 3 for a wider shot". Single `/api/refine` endpoint that takes the current timeline + a prompt and returns a patch (reorders, beat changes, swaps).
- **Vibe / mood selector** — text → biases AI selection prompts (`scripts/analyze.sh`) and editing pace.
- **Live Supabase + Clerk + Vercel provisioning** — see the "Backend setup plan" section near the top of this file. That work supersedes whatever's left here.

## Verification commands

```bash
# Type-check and lint
npx tsc --noEmit && npm run lint

# Smoke the AI route headless (skips Next.js entirely)
mkdir -p tmp-demo/upscaled
sips -Z 512 tmp-demo/beach.png --out tmp-demo/upscaled/beach.png
MAX_PICKS=3 CLAUDE_MODEL=haiku scripts/analyze.sh \
  "id=beach:$PWD/tmp-demo/upscaled/beach.png"

# End-to-end via the AI API route (requires dev server running)
curl -s -X POST -H "Content-Type: application/json" \
  --data @/tmp/montaj-body.json http://localhost:3737/api/analyze

# Smoke the HEVC transcode route
curl -s -o /tmp/out.mp4 -D - -X POST \
  -F "video=@tmp-demo/hevc/IMG_1803.MOV" \
  http://localhost:3737/api/transcode-video
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags -of csv=p=0 /tmp/out.mp4 | grep ',K'
# expect one keyframe per second
```

## File map

| File | Purpose |
|---|---|
| `src/components/montaj-week-one.tsx` | Main page; owns `timeline`, `selectedTrack`, `beatGrid`, `currentFrame`. Holds `playerRef`. Computes `perSlotFrames`, `perSlotStartFrames`, `totalFrames`, `durationInFrames`. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. Consumes `transitionFrames` and computes overlap-aware `perSlotPlayerStartFrames`. |
| `src/components/slideshow-composition.tsx` | Remotion composition. `<Video>` slots with conditional `trimBefore` for video front-trim, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset envelope + autocorrelation BPM. Cached per-track. |
| `src/lib/media.ts` | `TimelineMedia` type, music library, Supabase upload helper, HEIC handling, **`transcodeIfHevc`** that posts video uploads to `/api/transcode-video`. |
| `src/app/api/analyze/route.ts` | Decodes data URLs to temp dir, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. |
| `src/app/api/transcode-video/route.ts` | Streams uploads to `/tmp`, ffprobes codec, returns 204 if H.264, otherwise transcodes via `spawn('ffmpeg', …)` and returns `video/mp4`. 250 MB cap. |
| `scripts/analyze.sh` | `claude -p` wrapper with strict JSON schema. Prints `structured_output`; exit 4 if absent. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at four BPMs. |
| `tmp-demo/hevc/` | Real iPhone HEVC clips (`.MOV`) and HEIC photos for trim-stutter reproduction. Gitignored. |
