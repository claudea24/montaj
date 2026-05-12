# Montaj — Notes for Claude Code

Project-scoped notes. The repo-root `CLAUDE.md` (one directory up) covers global security and Supabase MCP setup; this file is montaj-specific.

## Recent work — backend + deploy shipped (2026-05-12)

Steps 1–4 of the backend setup plan are done. App is live at <https://montaj-psi.vercel.app> with auth, per-user persistence, autosave, and a working dashboard. See `summary.md` for the session log.

**Where things stand:**
- Clerk + Supabase third-party-auth integration is live (April 2025 pattern).
- Schema: `projects` + `assets` tables with RLS scoped on `auth.jwt()->>'sub'`.
- Storage RLS on `montaj-media` keyed by path prefix `{user_id}/`.
- 15 s client-side autosave writes `projects.document` directly.
- Asset library persists per project; signed URLs rebuild on load.
- Vercel auto-deploys on push to `main`.

**Active issue:** video-on-reload error is improved but still flaky — see "Active issue" below.

## Backend setup plan (status)

### Step 1 — Supabase MCP ✅

Authenticated; bucket `montaj-media` created (private); RLS verified via advisors.

### Step 2 — Clerk auth ✅

`@clerk/nextjs` installed. `<ClerkProvider>` in root layout. `src/middleware.ts` protects everything except `/sign-{in,up}` and the public API routes. `useSession`-based browser client in `src/lib/supabase-browser.ts` and `auth().getToken()`-based server client in `src/lib/supabase-server.ts`. Sign-in / sign-up pages mounted under `src/app/sign-{in,up}/[[...rest]]/page.tsx`.

### Step 3 — Schema ✅ *(simplified)*

Original PRD specified immutable timeline versions + asset versions. User explicitly chose the minimal cut on 2026-05-12: "we can add the versions later". Final schema is **two tables**:

- `public.projects` — `id uuid, user_id text, name, document jsonb, document_updated_at, created_at, updated_at`. `document` holds the full timeline state (`timeline`, `selectedTrackId`, `targetSeconds`). `updated_at` is maintained by trigger `touch_updated_at` (with `SET search_path = public`).
- `public.assets` — `id uuid, user_id text, project_id uuid (cascade), kind, name, size_bytes, storage_path, duration_seconds, width, height, metadata, created_at`.

RLS on both: `(select auth.jwt()->>'sub') = user_id`, `to authenticated`, all four verbs (select/insert/update/delete). Storage RLS on `storage.objects` requires `(storage.foldername(name))[1] = (select auth.jwt()->>'sub')`.

Path convention for uploads: `montaj-media/{user_id}/{project_id}/{uuid}-{safeName}`.

**What was intentionally not built** (deferred until concrete need):
- `timeline_versions` / `asset_versions` tables.
- Server-side autosave route — autosave is a 15 s client interval calling `update projects set document=…`.
- Railway workers — discussed but no concrete workload yet.

### Step 4 — Vercel deploy ✅

Project: **claudea24s-projects/montaj**. Live URL: <https://montaj-psi.vercel.app>. 5 env vars set in Vercel (Production + Preview); `CLERK_SECRET_KEY` is Sensitive. GitHub auto-deploy connected. Clerk is still on **dev keys** — swap to production before a real launch and add `montaj-psi.vercel.app` to Clerk allowed origins.

**Vercel ffmpeg gap:** `/api/transcode-video` will 500 on HEVC uploads in production. Fix when needed: add `@ffmpeg-installer/ffmpeg` (smallest), use `ffmpeg.wasm` client-side (medium), or move to a Railway worker (proper long-term).

## Repo facts

- **Framework:** Next.js 16 App Router, Tailwind 4, TypeScript.
- **Auth:** Clerk (`@clerk/nextjs`). Identity is the Clerk userId (`auth.jwt()->>'sub'`); there are no Supabase auth users.
- **Backend:** Supabase (`uxvqnlfeghyxgxffiukz`). Browser uses `useSupabaseClient()` from `src/lib/supabase-browser.ts`; server routes use `createServerSupabaseClient()` from `src/lib/supabase-server.ts`.
- **Storage:** private bucket `montaj-media`; signed URLs (24 h TTL) are minted via `createSignedUrls` on project load.
- **Autosave:** 15 s client interval; flips dirty when `timeline` / `selectedTrack` / `targetSeconds` changes. Save badge in top-right toolbar.
- **Video engine:** Remotion 4.0.457 — `remotion`, `@remotion/player`, `@remotion/transitions` are all pinned to that minor. Do not bump only one of them; that produces two parallel `remotion` packages and breaks the player context at runtime.
- **AI selection:** runs through `scripts/analyze.sh`, which spawns `claude -p` headless with `--system-prompt`, `--json-schema`, `--allowedTools Read`, and `--dangerously-skip-permissions`. The Next.js route at `src/app/api/analyze/route.ts` decodes incoming data URLs to a temp dir, spawns the bash script, and parses `structured_output`. There is no OpenAI dependency.
- **HEVC transcode:** every video upload posts to `POST /api/transcode-video`. The route streams the file to `/tmp/montaj-transcode-*`, ffprobes it, returns `204 No Content` for H.264 inputs, and otherwise transcodes via `ffmpeg -c:v libx264 -vf scale=1280 -r 30 -crf 23 -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart -c:a aac`. Server-side `ffmpeg` + `ffprobe` must be on `PATH` (`brew install ffmpeg` on macOS). 250 MB input cap; 120 s `maxDuration`. **Vercel does not ship ffmpeg** — see Step 4.
- **Music tracks:** seven 24-s loops in `public/music/*.wav`. Regenerate with `node scripts/gen-music.mjs` (procedural kick + pad + hat synth at four BPMs).
- **Dev server:** `PORT=3737 npm run dev`. Type-check / lint: `npx tsc --noEmit && npm run lint`.

## Conventions

- **RLS pattern:** every table has `user_id text` and policies `(select auth.jwt()->>'sub') = user_id` with `to authenticated`. Storage policies use `(storage.foldername(name))[1] = (select auth.jwt()->>'sub')`. When adding new tables, mirror this exactly.
- **Upload path:** `{user_id}/{project_id}/{uuid}-{safeName}` (special chars in name are replaced with `_`). The path is what's saved in `assets.storage_path`.
- **Library → timeline drag clones, doesn't move.** Library is a palette that persists; timeline copies use a fresh `crypto.randomUUID()` so the same asset can appear multiple times.
- **TimelineMedia.src on load:** must be resolved from `storagePath` via signed URLs. `resolveTimelineMediaUrls()` does this on project open; items with stale `blob:` URLs and no `storagePath` are dropped (Remotion's `<Video>` crashes on them).
- **Save state:** `dirtyRef` flips on any `timeline`/`selectedTrack`/`targetSeconds` change after project load. The autosave interval reads-then-clears `dirtyRef`; if the write fails, `dirtyRef` is set back to true so the next tick retries.
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

**"Error occurred in video {}" on project reload — partial fix, still flaky.**

Symptom: Remotion's `<Video>` errors with an empty `{}` payload after opening a project that was saved in a prior session. Root cause was stale `blob:` URLs in the persisted `document.timeline` — those URLs are revoked when the page reloads.

Fix applied:
1. Every upload now writes `assets` row + sets `storagePath` on the `TimelineMedia`.
2. `resolveTimelineMediaUrls()` in `src/lib/media.ts` rebuilds signed URLs from `storagePath` when a project loads.
3. Items with no `storagePath` and only a stale `blob:` src are dropped from the timeline at load time.

**Status: improved but still surfaces.** Suspected remaining cases:
- Projects edited before `storagePath` existed (older documents).
- Signed URL expiring mid-session (24 h TTL, but long edits could exceed).
- Race when the loader resolves URLs before Supabase auth token is ready (the `useEffect` depends on `supabase` which depends on `useSession` — there might be a window).

To investigate next: open the editor, watch the network tab for any `montaj-media` request returning 4xx, and instrument `resolveTimelineMediaUrls` to log which items it drops.

## Next steps — Sprint Backlog

Phased and prioritized. Check items off as they ship.

### 🔴 Phase 1: Stability & Security (critical path)

**Goal:** stop the crashes and lock down the data.

- [ ] **Debug "Video {}" reload error**
  - [ ] Add a loading state to the timeline (`isResolving`) so Remotion doesn't mount stale `blob:` URLs before `resolveTimelineMediaUrls()` completes.
  - [ ] Implement a fallback for "legacy" assets that might be missing a `storagePath`.
  - [ ] Add a `URL.revokeObjectURL()` cleanup routine to prevent memory leaks during long sessions.
- [ ] **Address security audit findings**
  - [ ] Review `security_audit_report.md` and commit or delete the untracked file.
  - [ ] **Production auth:** swap Clerk to production keys and restrict allowed origins to `montaj-psi.vercel.app`.
  - [ ] **Database hardening:** verify RLS policies specifically for the `assets` table to ensure users can't "guess" other users' asset IDs.

### 🟠 Phase 2: Core editing suite (feature parity)

**Goal:** turn the "player" into a "creator."

- [ ] **Text editing engine**
  - [ ] Update `projects.document` JSONB schema to support text layers (font, size, color, position).
  - [ ] Build a "Text" tab in LeftNav with drag-to-timeline functionality.
- [ ] **Transitions library**
  - [ ] Integrate `@remotion/transitions` (already a dep — extend the active cycle).
  - [ ] Build logic to handle frame-overlap between clips for fades and wipes.
- [ ] **Emoji & stickers**
  - [ ] Implement an SVG-based emoji picker in LeftNav.
  - [ ] Add "Transform" controls (scale / rotate) for emojis on the timeline.

### 🟡 Phase 3: Infrastructure & AI (stretch)

**Goal:** scale up and add the "magic."

- [ ] **Infrastructure migration**
  - [ ] Move video processing / transcoding to Railway to bypass Vercel's FFmpeg limitations.
- [ ] **AI asset enrichment**
  - [ ] Implement auto-captioning (Speech-to-Text) via OpenAI Whisper or similar.
  - [ ] Add "Smart Search" for the library using AI-generated tags for uploaded clips.

### 🚀 Quick-Start for Tomorrow

- **The fix:** wrap the editor in an `isResolving` boolean to ensure `resolveTimelineMediaUrls()` finishes before the video tries to play.
- **The cleanup:** finalize `security_audit_report.md` — it's the only thing sitting outside git history.

## Backlog — not on current sprint (reference)

Deprioritized but kept here so they're not lost. Re-promote into the sprint when relevant.

### Library thumbnails for loaded assets

`extractVideoThumbnails` runs only on fresh uploads. Loaded library items have no `previewFrames` and look blank. Either run extraction lazily on render, or store thumbnails alongside the asset row (base64 in `metadata`, or a separate `thumbnail_path` storage object).

### Smart video trim — AI picks the right window

For each uploaded video, automatically choose `videoStartBeats` and `beats` so the active range lands on the stable, scenic part. Server route `POST /api/trim-suggest` samples ~8 frames via ffmpeg, computes a stability score (scene-cut count + motion magnitude), and asks `claude -p` which 1–2 s window is best. Combine stability ("watchable") with AI vision ("beautiful"), snap to beats, set on the clip. New files: `src/app/api/trim-suggest/route.ts`, `scripts/trim-suggest.sh`, plus a `TrimSuggestion` type in `src/lib/ai.ts` and a "Smart trim" button in the editor.

### AI picks reel timing — music length matched to content

Extend `/api/analyze`'s response with `suggestedReelSeconds: number`. Prompt: "Suggest a reel length 8–30 s, biased toward 12 s for ≤6 clips, 18 s for 7–10 clips, 25 s for >10 clips, but bend for content." After analysis, set `targetSeconds` and invoke `autoFit()`. Keep the slider editable so the user can override.

### yt-dlp trending music — paste a URL, fit it to the reel

Server route `POST /api/fetch-audio` spawns `yt-dlp -x --audio-format wav -o /tmp/montaj-audio/<uuid>.wav <url>`, probes duration, moves under `public/music/fetched/`. Add a paste-URL section to the Soundtrack panel with a TOS warning (yt-dlp violates platform ToS; fetched audio is for preview only, never embedded in export). When source is yt-dlp-fetched, export must be **video-only**. Gotchas: `yt-dlp` on `PATH`, expect TikTok flakiness, store under `/tmp` only (gitignored).

### MP4 export

Remotion `@remotion/renderer` server route, with a "video-only" branch when the soundtrack is yt-dlp-fetched. The slot uses `<Video>` for preview smoothness; renderer mode honors that, but `<OffthreadVideo>` via `getRemotionEnvironment().isRendering` is the documented escape hatch if fidelity issues appear. Once export exists, provision a Railway service to run the renderer — trigger via a new `exports` table (Vercel inserts `pending` → Railway watches via Postgres LISTEN/NOTIFY → renders → uploads to `montaj-exports` bucket → updates row to `done`). This is also where HEVC transcode should move.

### Natural-language AI refinement

Single `/api/refine` endpoint that takes the current timeline + a prompt ("make the intro faster", "swap clip 3 for a wider shot") and returns a patch (reorders, beat changes, swaps).

### Vibe / mood selector

Text input → biases AI selection prompts (`scripts/analyze.sh`) and editing pace.

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

# Smoke prod
curl -sS -D - -o /dev/null -H "Accept: text/html" https://montaj-psi.vercel.app/ | head -5
# expect 307 → Clerk handshake
```

## File map

| File | Purpose |
|---|---|
| `src/app/layout.tsx` | `<ClerkProvider>` wrapper around `<html>` / `<body>`. |
| `src/app/page.tsx` | `/` route. Renders `<MontajWeekOne projectId={null} />` (editor shell with Dashboard tool active). |
| `src/app/projects/[id]/page.tsx` | `/projects/[id]` route. Renders `<MontajWeekOne projectId={id} />`. |
| `src/app/sign-in/[[...rest]]/page.tsx` · `src/app/sign-up/[[...rest]]/page.tsx` | Clerk hosted forms. |
| `src/middleware.ts` | `clerkMiddleware` with `auth.protect()` for non-public routes. Public matcher: `/sign-in*`, `/sign-up*`, `/api/transcode-video`, `/api/analyze`. |
| `src/components/montaj-week-one.tsx` | Main editor. Owns `timeline`, `library`, `selectedTrack`, `targetSeconds`, save state, autosave loop, project loader, asset loader, dashboard panel, left nav, media panel switch. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. Consumes `transitionFrames` and computes overlap-aware `perSlotPlayerStartFrames`. |
| `src/components/slideshow-composition.tsx` | Remotion composition. `<Video>` slots with conditional `trimBefore`, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset envelope + autocorrelation BPM. Cached per-track. |
| `src/lib/media.ts` | `TimelineMedia` type, music library, auth-aware upload, asset row insert, `loadProjectAssets`, `resolveTimelineMediaUrls`, HEIC handling, `transcodeIfHevc`. |
| `src/lib/projects.ts` | `projects` CRUD: `listProjects`, `createProject`, `getProject`, `updateProjectDocument`, `renameProject`, `deleteProject`. |
| `src/lib/supabase-browser.ts` | `useSupabaseClient()` — Clerk session token via `useSession()`, memoized per session. |
| `src/lib/supabase-server.ts` | `createServerSupabaseClient()` — `auth().getToken()` for server routes (not yet used in app code; ready when we add server data fetching). |
| `src/app/api/analyze/route.ts` | Decodes data URLs to temp dir, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. **Public** (no Clerk gate in middleware) — abuse-able; tighten when we add quotas. |
| `src/app/api/transcode-video/route.ts` | Streams uploads to `/tmp`, ffprobes codec, returns 204 if H.264, otherwise transcodes via `spawn('ffmpeg', …)` and returns `video/mp4`. 250 MB cap. **Public** for the same reason. |
| `scripts/analyze.sh` | `claude -p` wrapper with strict JSON schema. Prints `structured_output`; exit 4 if absent. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at four BPMs. |
| `tmp-demo/hevc/` | Real iPhone HEVC clips (`.MOV`) and HEIC photos for trim-stutter / reload reproduction. Gitignored. |
