# Montaj

Beat-locked, AI-assisted Instagram-reel editor. Sign in with Clerk, create projects, upload travel photos and clips, an AI director picks and orders them into a story, and a CapCut-style timeline at the bottom lets you refine. Live 9:16 preview with transitions, captions, and music that loops to fit any 8–30 s reel. Projects autosave every 15 s.

**Live:** <https://montaj-psi.vercel.app>

## Pipeline

1. **Sign in** — Clerk handles email/password and Google OAuth. Every Supabase request carries a Clerk-issued JWT; RLS scopes every row to the signed-in user.
2. **Dashboard** — the first tool in the LeftNav. Lists your projects, lets you create a new one (inline name input), rename, or delete. Click a project to load it.
3. **Upload** — JPG / PNG / WebP / HEIC photos and MP4 / MOV / M4V clips. HEIC is converted to JPEG client-side. iPhone HEVC video is transcoded to H.264 server-side via `POST /api/transcode-video` (ffmpeg required on `PATH` locally; Vercel needs `@ffmpeg-installer/ffmpeg` to be added when deploying HEVC support). Uploads go to `montaj-media/{user_id}/{project_id}/...` and insert a row in `public.assets`.
4. **Asset library** — every file you upload for a project shows up in the Media tab and persists across reloads / tab switches. Drag from library to the rail; the item *stays* in the library so you can drop it multiple times.
5. **Beat detection** — the browser decodes the chosen soundtrack via Web Audio, computes a 10 ms-hop energy onset envelope, and finds tempo by autocorrelation in the 70–180 BPM band. Cached per track URL.
6. **AI selection** — *Auto-pick* posts each photo (resized to 512 px) to `/api/analyze`, which shells out to `claude -p` headless with a strict JSON schema. Claude scores each photo (scene + quality + caption) and returns a story arc (hook → build → climax → outro). On failure the route falls back to a heuristic ordering and surfaces the reason in the UI.
7. **Edit** — drag clips to reorder; drag the left edge of a video to *front-trim*, the right edge to *tail-trim* (one-beat snap, 44 px / beat). A 3-segment grey/green/grey filmstrip on each video shows where the active range sits in the source. *Auto-fit* distributes a target reel length 8–30 s evenly across all clips.
8. **Preview** — Remotion Player at 1080 × 1920, 30 fps. Ken-Burns motion on photos, transitions cycling fade → slide → wipe between every slot, AI captions rendered as a centered overlay editable inline. Audio loops via Remotion's `<Loop>` so reels longer than the 24 s source keep playing without silence.
9. **Autosave** — every 15 s a dirty document is upserted to `projects.document`. A save badge in the toolbar shows `Saving…` / `Saved 14:23` / `Save failed`.

## Prerequisites

- **Node.js 20+** and **npm**
- **ffmpeg** and **ffprobe** on `PATH` for the HEVC transcode route (`brew install ffmpeg` on macOS)
- **Claude Code CLI** for the AI selection route (`scripts/analyze.sh` invokes `claude -p`)
- **Supabase project** (required — see setup below)
- **Clerk application** (required — see setup below)

## Run

```bash
npm install
PORT=3737 npm run dev
```

Open <http://localhost:3737>.

Type-check / lint:

```bash
npx tsc --noEmit && npm run lint
```

## Supabase + Clerk setup

Copy `.env.example` to `.env` (or `.env.local`) and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-publishable-or-anon-key>
NEXT_PUBLIC_SUPABASE_BUCKET=montaj-media
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

Then in dashboards (one-time):

1. **Clerk → [Supabase integration setup](https://dashboard.clerk.com/setup/supabase)** → Activate → copy the **Clerk domain**.
2. **Supabase → Authentication → Sign In / Up → Add provider → Clerk** → paste the domain.
3. **Supabase**: create the `montaj-media` storage bucket (private).
4. **Schema**: the `projects` and `assets` tables plus RLS policies live in the migration history of the Supabase project (`init_app_schema` + `storage_rls_montaj_media`).

## Deploy (Vercel)

Project is already linked to **claudea24s-projects/montaj**. GitHub auto-deploy is connected — push to `main` deploys to production at <https://montaj-psi.vercel.app>.

Env vars are set in the Vercel dashboard (Production + Preview only — Development is unchecked because local `.env` covers that case). `CLERK_SECRET_KEY` is marked Sensitive.

**Known gap:** Vercel doesn't ship `ffmpeg`, so `/api/transcode-video` will 500 on HEVC uploads in production. Add `@ffmpeg-installer/ffmpeg` as a dep (or move transcode to a Railway worker) when HEVC support is needed live.

## Stack

Next.js 16 (App Router) · Tailwind 4 · TypeScript · `@clerk/nextjs` · `@supabase/supabase-js` · Remotion 4.0.457 (`player` + `transitions`, both pinned) · `@dnd-kit/core` + `@dnd-kit/sortable` · `heic-to`. Server-side ffmpeg + ffprobe for HEVC transcode. Claude Code CLI for AI scoring.

## Layout

| File | Purpose |
|---|---|
| `src/app/layout.tsx` | `<ClerkProvider>` wrapper. |
| `src/app/page.tsx` | `/` route — renders the editor shell with no project loaded (Dashboard tool active). |
| `src/app/projects/[id]/page.tsx` | `/projects/[id]` route — editor with the project loaded. |
| `src/app/sign-in/[[...rest]]/page.tsx` · `src/app/sign-up/[[...rest]]/page.tsx` | Clerk hosted forms. |
| `src/middleware.ts` | Clerk middleware. Protects everything except `/sign-{in,up}` and `/api/{analyze,transcode-video}`. |
| `src/components/montaj-week-one.tsx` | Main editor; owns timeline, library, player ref, frame state, beat grid, AI status, autosave loop, dashboard panel. |
| `src/components/timeline-rail.tsx` | CapCut rail. Drag handles, ghost filmstrip, beat ticks, playhead, click-to-seek. Overlap-aware. |
| `src/components/slideshow-composition.tsx` | Remotion composition. `<Video>` slots with conditional `trimBefore`, looped audio, captions, transitions. |
| `src/lib/beats.ts` | Web Audio onset + autocorrelation BPM detector, cached per track. |
| `src/lib/media.ts` | `TimelineMedia` type, music library, auth-aware upload, asset row insert, signed-URL resolution for library / timeline reloads, HEIC handling, HEVC transcode call. |
| `src/lib/projects.ts` | `projects` CRUD: list / create / get / update document / rename / delete. |
| `src/lib/supabase-browser.ts` | `useSupabaseClient()` hook — Clerk-session-aware client. |
| `src/lib/supabase-server.ts` | `createServerSupabaseClient()` — `auth().getToken()`-based for server routes. |
| `src/app/api/analyze/route.ts` | AI scoring. Decodes data URLs, spawns `scripts/analyze.sh`, parses JSON, heuristic fallback. |
| `src/app/api/transcode-video/route.ts` | HEVC → H.264 transcode. Streams upload to `/tmp`, ffprobes codec, returns 204 if H.264, otherwise re-encodes via ffmpeg. |
| `scripts/analyze.sh` | `claude -p` headless wrapper with `--json-schema` and minimal `--system-prompt`. |
| `scripts/gen-music.mjs` | Procedural WAV generator (kick + pad + hat) at 92 / 100 / 112 / 128 BPM. |
| `public/music/*.wav` | Seven 24-s royalty-free demo loops. |

## Documentation

- `PROJECT_PROPOSAL.md` — original design spec and per-week status updates.
- `CLAUDE.md` — project-scoped notes for Claude Code: schema, RLS, conventions, current active issue with diagnosis playbook, ordered next-steps roadmap.
- `summary.md` — most recent session log.
