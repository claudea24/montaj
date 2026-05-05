# Project Proposal: Montaj

**Author:** Claudea Jennefer
**Course:** MPCS 51238 — Design Build Ship
**Date:** April 14, 2026

> I'm presenting two directions for the same project and would appreciate guidance on which to pursue — or whether combining them makes sense. I'm leaning toward Option B (the reel remix concept) because it feels genuinely novel, but Option A is more technically straightforward in a 4-week timeline. Both share the same core: AI helps turn raw travel content into polished reels. I'd love your input on scoping and direction.

---

# Option A: Montaj — AI Creative Director

## One-Line Description
An AI-powered reel maker that analyzes my travel photos and videos, picks the best ones, arranges them into a story, and produces a beat-synced reel ready for Instagram, TikTok, or YouTube Shorts.

## The Problem
I come back from every trip with 50-100 favorited photos and 10-20 short videos, and almost none of them get posted. It's not that I don't want to share — it's that I don't know where to start. Which photos should I use? What order tells a good story? How do I match cuts to music? How do I keep it visually interesting so people actually watch to the end?

Tools like CapCut exist, but they still expect me to make all the creative decisions. I know what a good reel looks like when I see one — I just can't make one myself. Montaj fills that gap. I upload my content, and AI handles the creative direction. I stay in control to refine, but I don't have to start from a blank timeline.

## Target User
Myself, and people like me — travelers who take lots of photos and videos, have a sense of taste for what looks good, but don't have the editing skills or patience to produce polished social content. Not professional creators. Just regular people who want their posts to look great.

## Core Features (v1)
1. **Upload a batch** — Drag and drop all my favorited photos and videos from a trip into the app.
2. **AI selects and arranges** — AI vision analyzes each piece of content (beach, food, group shot, sunset, action clip), scores them for quality and variety, picks the best 10-20, and arranges them into a narrative arc (hook → build → climax → ending). I don't have to sort anything manually.
3. **Music + beat sync** — Two options:
   - **Royalty-free or own audio**: Pick from a built-in library by mood, or upload my own audio file. Export includes audio — ready to post as-is.
   - **Popular song via URL or file upload**: Paste a link to a reel, TikTok, or YouTube Short — yt-dlp fetches the audio. Or if the URL doesn't work, upload the video/audio file manually (screen recording, saved TikTok, etc.). Either way, the app detects beats and syncs cuts to them. I use the audio for preview and timing, but the export is video-only — I add the same song in-platform when I post.
4. **Live preview + AI refinement** — Watch the reel in a full in-browser preview. Refine by telling the AI what to change ("make the intro more energetic", "swap clip 3 for something brighter") or by dragging and dropping on the timeline. Both modes work together.
5. **Smart export** — If I used royalty-free or my own audio, export includes the music — ready to post. If I used a popular song via URL, export is video-only so I can add the licensed song in-platform. Either way, the cuts are synced to the beats.

## Tech Stack
- **Frontend**: Next.js (App Router) — React-based, works naturally with Remotion for video rendering
- **Styling**: Tailwind CSS — fast to iterate on the editor UI
- **Video Engine**: Remotion (`@remotion/player` for live preview, `@remotion/transitions` for transitions, `@remotion/renderer` for export) — a React-based video framework, free for students
- **Database**: Supabase — file storage for uploaded media (Supabase Storage), project state (Postgres), and bundled royalty-free music
- **Auth**: Clerk — can add later if needed; not required while it's just me using it
- **AI/APIs**:
  - OpenAI gpt-4o-mini (vision) — analyze content, score quality, suggest narrative ordering, generate captions
  - yt-dlp (server-side) — fetch audio from reel/TikTok/Short URLs when using popular songs for beat sync
  - Web Audio API + client-side beat detection — extract beat timestamps from audio in the browser (no cost)
  - MusicGen on Replicate (stretch goal) — AI-generated background music from a text prompt
- **Drag-and-drop**: `@dnd-kit/core` — for the timeline editor
- **Deployment**: Vercel (free tier)
- **MCP Servers**: Supabase MCP (database management), Playwright MCP (end-to-end testing)

**Estimated cost:** Under $1/month. Beat detection and video rendering run client-side. The only API cost is OpenAI vision for analyzing photos (~$0.003/image). Vercel, Supabase, and Remotion are all free at this scale.

## Stretch Goals
- **AI-generated music** — Custom background tracks from a text prompt via MusicGen ("upbeat tropical, 30 seconds")
- **AI voiceover** — Auto-generated narration ("We started the morning exploring...") synced to the timeline
- **Template system** — Save and reuse editing styles across different trips
- **PWA** — Make the web app installable on mobile via Progressive Web App
- **Direct social posting** — Post to Instagram/TikTok directly from the app

## Biggest Risk
**AI content selection quality.** The whole experience depends on AI picking good photos and putting them in an order that feels like a story. If it picks bad shots or the arrangement feels random, the product doesn't work. My plan is to start with straightforward heuristics (ensure variety, no near-duplicates, quality scoring) and add smarter narrative logic as I go. The user can always override anything with drag-and-drop, so a mediocre first draft is still useful as long as it's easy to fix.

The timeline editor UI is also a significant build — Remotion handles the rendering, but the interactive editing experience is custom React. I'll start with a simple ordered list and iterate toward something more polished.

**A note on yt-dlp and platform TOS:** Using yt-dlp to fetch audio from reel/TikTok/Short URLs does violate platform Terms of Service (YouTube, Instagram, and TikTok all prohibit automated downloading). However, Montaj's use case is narrow and defensible: the audio is fetched temporarily for beat detection (extracting timing data), used during preview, and never included in the final export. The output is video-only — no copyrighted audio is redistributed. This is closer to "intermediate copying" for analysis than content piracy. For a non-commercial student project with no public distribution, the practical risk is negligible. If this were ever commercialized, I'd switch to requiring users to upload their own audio files or use official platform APIs.

## 4-Week Milestones

### Week 1 — Scaffold + upload + basic preview (~10-15 hours)
- Project scaffolded with Next.js + Tailwind and deployed on Vercel
- Upload photos (drag-and-drop UI + Supabase Storage)
- Bundle a small royalty-free music library (5-10 tracks by mood) and build a simple picker UI
- Basic Remotion Player integration — photos display in sequence with fixed timing (one photo per second), music plays alongside

**Demo:** "I upload my trip photos, pick a song, and see a basic slideshow with music playing in my browser. It's not beat-synced yet, but the foundation is live."

**Status (end of Week 1):**
- ✅ Next.js 16 (App Router, Turbopack) + Tailwind 4 scaffold, repo public at https://github.com/claudea24/montaj
- ✅ Drag-and-drop and file-picker upload, with the Supabase Storage code path wired in `src/lib/media.ts` (falls back to in-browser blob URLs when env vars are unset)
- ✅ Royalty-free music library (3 tracks: Coastline / Night Drive / Postcard), picker UI with inline `<audio>` preview
- ✅ Remotion Player rendering a 1080×1920/30fps `SlideshowComposition` with photos at 1s each and the soundtrack mounted
- ➕ **Beyond plan:** HEIC/HEIF photos accepted (converted to JPEG client-side via `heic-to` so Chrome can render them) and MOV/MP4/M4V clips accepted (duration probed from metadata, played full-length via `<OffthreadVideo>` in the slideshow)
- ⏩ **Pulled forward from Week 2:** Ken Burns visual variety (4-variant motion cycle: zoom-in / zoom-out / pan-right / pan-left, applied to images only) and basic reordering UI (↑/↓/✕ buttons per timeline item with blob-URL cleanup on remove)
- ⏸️ **Deferred:** Vercel deploy and live Supabase project provisioning. The upload code is storage-ready, but the project hasn't been created yet — planned alongside Clerk auth in Week 2.

### Week 2 — Beat sync + AI selection (~25-30 hours)
- Beat detection in-browser (Web Audio API), auto-sync photo timing to beats
- AI vision analyzes all uploads (beach, food, sunset, group shot), selects the best subset, and arranges them into a narrative arc
- Visual variety: zoom in/out, pan effects so photos aren't static *(✅ shipped in Week 1)*
- Basic reordering UI (swap and move clips — doesn't need to be full drag-and-drop yet) *(✅ shipped in Week 1)*

**Revised Week 2 plan:** With the two visual/UX items already in, Week 2 focuses on (a) standing up Supabase + Clerk with per-user storage isolation so uploads persist, then (b) beat detection (Web Audio API onset analysis driving per-slot frame counts), and (c) AI vision selection via OpenAI gpt-4o-mini scoring + narrative ordering.

**Demo:** "Photos now snap to the beat, AI picks and orders my best shots into a story, and each photo has a zoom or pan so it's not a static slideshow."

**Status (end of Week 2):**
- ✅ Web Audio beat detection (`src/lib/beats.ts`): decodes the soundtrack, computes a 10ms-hop energy onset envelope, picks tempo by autocorrelation in the 70–180 BPM band, and phase-aligns beats. Results are cached per track URL.
- ✅ Beat-synced timing: `MontajWeekOne` runs detection on track change and feeds per-slot frame counts to `SlideshowComposition`. Photos snap to `beats × beatsPerSlot` (1–4, exposed as a slider); videos still play their full natural length.
- ✅ BPM/beat count surfaced in the UI alongside a "Sync photos to beat" toggle so the un-synced fixed-1s timing remains available for comparison.
- ✅ AI vision selection runs through Claude Code headless. `scripts/analyze.sh` builds the editor prompt from the photo paths and pipes it to `claude -p --json-schema ... --allowedTools Read --dangerously-skip-permissions`; `--system-prompt` overrides the default agent prompt to keep token usage tight. The server route `src/app/api/analyze/route.ts` decodes incoming data URLs into a temp dir, spawns the bash script, and parses the `structured_output` into `AnalysisResult { items, orderedIds, source }`. Verified end-to-end: `POST /api/analyze` returned `source: "claude"` with scene/qualityScore/caption per photo and a narrative `orderedIds` arc, ~24s round-trip on `haiku` for three photos.
- ✅ Graceful fallback: any failure (missing `claude` binary, schema mismatch, non-zero exit) falls back to a heuristic ordering and surfaces the reason in the UI.
- ⚠️ **Cost note:** each call writes ~30K cache tokens because Claude Code still loads tool descriptions and plugin metadata even with `--system-prompt`; `--bare` would skip that but only works with `ANTHROPIC_API_KEY` auth, not the OAuth subscription. Acceptable for the demo; for production this would move to the Anthropic SDK directly.
- ⏸️ **Still deferred:** Live Supabase + Clerk provisioning (per-user storage isolation). The upload code paths remain "configured-or-fall-back-to-blob-URLs"; tracking this for the Week 4 polish window so the demo doesn't depend on cloud setup.

### Week 3 — Timeline editor + transitions (~25-30 hours)
- Full drag-and-drop timeline with @dnd-kit (reorder, swap, adjust timing)
- Transitions between clips (fade, slide, wipe)
- AI-suggested text overlays and captions based on photo content
- Editable caption UI if time allows

**Demo:** "I can drag and drop to rearrange everything, the reel has smooth transitions and AI-generated captions."

**Status (end of Week 3):**
- ✅ Drag-and-drop timeline with `@dnd-kit/core` + `@dnd-kit/sortable`. Each row has a grab handle (4px activation distance so touch/click selection still works), persists captions and scene tags through reorders, and replaces the Week 1 ↑/↓ buttons.
- ✅ Transitions between every slot via `@remotion/transitions`: cycles fade → slide → wipe, with each transition's overlap clamped to `min(prev, next, 12)` frames so short beats don't collapse the cut. Total `durationInFrames` is recomputed on the page so the Player's scrubber stays in sync.
- ✅ AI captions: the same `/api/analyze` call returns 4–7 word caption suggestions per photo, rendered as a centered overlay inside `SlotContent` and editable per-slot via a row-level text input that flows back into the Remotion preview live.
- ➕ **Beyond plan:** Aligned `remotion`, `@remotion/player`, and `@remotion/transitions` to the same minor (`4.0.457`) — the initial install left two `remotion` copies side-by-side which would have caused subtle context bugs at runtime.
- 🧪 **Verification gap:** I haven't driven a real browser through the full upload → AI-pick → reorder → caption flow yet. Type-check (`tsc --noEmit`) and lint pass; the dev server compiles, `GET /` is 200, and `POST /api/analyze` returns 200 with the heuristic fallback when no API key is set. End-to-end click-through is the first thing on the Week 4 list.

**Status update — Week 3 CapCut rebuild (uncommitted at time of writing):**
- ✅ Layout switched to a CapCut/iMovie pattern: large 9:16 preview centered top, full-width horizontal timeline rail at the bottom, controls (Upload / Soundtrack / AI director) collapsed into a 360-px right sidebar.
- ✅ Music library expanded from 3 to 7 tracks. Four new procedurally-synthesized loops were added at 92 / 100 / 112 / 128 BPM via `scripts/gen-music.mjs` (kick + pad + hat synth, mono 16-bit 44.1 kHz, 24 s each) so the beat-locked editing is visible across tempos.
- ✅ Per-clip beat counts: every `TimelineMedia` carries explicit `beats` (and videos carry `videoStartBeats`). The page-level "beats per slot" slider was removed; per-clip control replaces it.
- ✅ CapCut-style drag handles: each clip has draggable left/right edges with 1-beat snap (44 px/beat), pointer capture, and dim states at min/max. Image clips resize on either edge; video clips treat the left edge as a *front-trim* (advances `videoStartBeats`, keeps the right edge fixed in source time) and the right edge as a *tail trim*.
- ✅ Video trim is honored in the Remotion preview via `OffthreadVideo startFrom={videoStartBeats × beatPeriod × fps}` — the source actually plays from the trim point.
- ✅ Grey ghost filmstrip: each video clip shows a 3-segment horizontal bar (head trim · active · tail trim) sized proportionally to `floor(durationSeconds / beatPeriod)`, with hover tooltips and head/tail seconds labels under it.
- ✅ 8–30 s reel clamp with amber ("under") / rose ("over") warnings. Right handle disables when over.
- ✅ Auto-fit + 8–30 s target slider: distributes target beats evenly across all clips, capped per-video by its own `maxBeats`. Resets `videoStartBeats` to 0.
- ✅ Music looping via Remotion's `<Loop>` so reels longer than the 24 s source loop continue without silence.
- ✅ Playhead + click-to-seek: `useRef<PlayerRef>` subscribes to the Remotion Player's `frameupdate` event; pink vertical line tracks playback on the rail; clicking the rail body computes per-clip x→frame and calls `seekTo`. All inner controls (handles, ✕, caption inputs) carry `stopPropagation` so they don't trigger seek.

**Open issue:** user reports a "broken video" rendering after the trim refactor. Investigation pending Playwright MCP install (or a direct `@playwright/test` devDep) for headless visual verification. Suspects logged in `montaj/CLAUDE.md`.

### Week 4 — Audio options + AI refinement + export (~25-30 hours)
- Support for uploading your own audio or pasting a URL (yt-dlp), with video-only export for URL-sourced audio
- AI refinement via natural language ("make the intro faster", "swap clip 3")
- Vibe/mood selector that shapes the AI's editing style
- Smart export: with audio (royalty-free/own) or video-only (popular song via URL)
- Optimized for Instagram Reels, YouTube Shorts, TikTok
- End-to-end polish for a live demo
- Bug fixes and basic performance optimization

**Fair demo:** I upload my actual travel photos on stage, AI builds a reel, I refine it, and export — start to finish.

---

# Option B: Montaj — Reel Remix Engine

## One-Line Description
Paste a link to a reel you love. Montaj reverse-engineers the editing style — cut timing, pacing, rhythm — and applies it to your own travel photos and videos.

## The Problem
I see reels on Instagram with perfect pacing — cuts that land on every beat, a flow that keeps me watching to the end, a mix of close-ups and wide shots that feels intentional. I want to make content that feels like that, but I don't know *how* they edited it. What's the timing? Where do the cuts happen? How do they alternate between shot types?

No tool lets me take a reel I admire and say "apply this editing style to my content." CapCut has templates, but they're manually created by the original editor — you can't point it at any random reel and extract the pattern. Montaj does exactly that. I'm not copying anyone's content. I'm learning from their editing instincts and applying them to my own photos and videos.

## Target User
Myself, and people like me — casual creators who have good raw content and a sense of taste, but can't bridge the gap between "I love how this reel feels" and "I can make something that feels like that." People who learn by example, not by studying video editing tutorials.

## Core Features (v1)
1. **Paste a reel link or upload a file** — Paste a URL to an Instagram Reel, TikTok, or YouTube Short — Montaj uses yt-dlp to fetch the video server-side. If the URL doesn't work (platforms sometimes block automated downloads), I can upload the video file manually instead (screen recording, saved TikTok, etc.). Either way works.
2. **AI extracts the editing pattern** — Montaj analyzes the video's structure: where the cuts happen, how long each segment is, the pacing rhythm, the energy arc (slow intro → build → peak → outro). It also extracts the audio and detects beats. It outputs an editable "edit template" — a blueprint of the reel's editing style.
3. **Sync validation** — Montaj compares the detected cut timestamps against the audio beat timestamps and shows a sync score (e.g., "90% of cuts land on a beat"). A visual timeline displays beat markers and cut markers so I can see exactly where they align and where they don't. If the sync is low, Montaj flags it so I know the template may need manual adjustment.
4. **Upload my content + AI fills the slots** — I drag in my travel photos and videos. AI vision analyzes each one (beach, food, sunset, group shot) and auto-matches them to the template's slots based on content type and visual style. The best-matching content goes into each slot automatically.
5. **Live preview + refinement** — Watch my content applied to the template in real-time. Refine with AI ("swap clip 3 for a wider shot", "make the ending longer") or drag-and-drop to reorder manually. The audio from the reference reel plays during preview so I can check timing against the actual music.
6. **Export video without audio** — Export to MP4 without audio. The video is edited to match the original reel's rhythm, so when I post to Instagram/TikTok and add the same song in-platform, the cuts will land on the beats. Audio is kept separate — I own the visuals, the platform handles the music licensing.

## Tech Stack
- **Frontend**: Next.js (App Router) — React-based, works with Remotion
- **Styling**: Tailwind CSS
- **Video Engine**: Remotion (`@remotion/player` for live preview, `@remotion/transitions` for transitions, `@remotion/renderer` for export)
- **Database**: Supabase — storage for uploaded media, saved templates, project state
- **Auth**: Clerk — can add later; not needed for personal use
- **AI/APIs**:
  - OpenAI gpt-4o-mini (vision) — analyze uploaded content for smart slot-matching, generate captions
  - FFmpeg (scene detection via `select='gt(scene,0.3)'`) + OpenAI vision — extract cut timestamps and classify each segment's visual style from the reference reel
  - yt-dlp (server-side) — fetch reference videos from Instagram Reels, TikTok, and YouTube Shorts by URL
  - Web Audio API + client-side beat detection — extract beat timestamps from the reference reel's audio for sync validation and template timing
- **Drag-and-drop**: `@dnd-kit/core` — for the timeline editor
- **Deployment**: Vercel (free tier)
- **MCP Servers**: Supabase MCP (database management), Playwright MCP (end-to-end testing)

**Estimated cost:** Under $1/month. FFmpeg scene detection and beat detection run client-side or on the server at no marginal cost. OpenAI vision is the only per-use cost (~$0.003/image).

## Stretch Goals
- **Template library** — Save extracted templates and build a personal collection of editing patterns from reels I like
- **Template sharing** — Let other users browse and use templates, building a community library
- **AI auto-select from batch** — Upload 100 photos and AI picks the best ones for each template slot
- **Music-aware templates** — Template timing adjusts to match the beats of a selected royalty-free track
- **AI voiceover** — Generate narration synced to the template structure
- **Template blending** — Combine elements from multiple reel templates into a hybrid style
- **PWA** — Installable on mobile

## Biggest Risk
**Template extraction accuracy.** Detecting cut points and pacing from an arbitrary reel is real computer vision work. If the extracted template has wrong timing (missed cuts, bad segment boundaries), the output will feel off. My plan is to use FFmpeg's scene detection (which is well-established) for cut timestamps, and OpenAI vision to classify the visual style of each segment. I'll start with simple reels that have clean, obvious cuts and work up to more complex editing styles. Users can always manually adjust the extracted template before applying it.

A secondary risk is yt-dlp reliability. Platforms occasionally change their anti-bot measures, which can break yt-dlp temporarily. Mitigation: yt-dlp is actively maintained and updates quickly. As a fallback, users can always upload a video file directly (screen recording or saved from camera roll) if a URL doesn't work.

**A note on yt-dlp and platform TOS:** Fetching videos via yt-dlp violates the Terms of Service of YouTube, Instagram, and TikTok (they prohibit automated downloading). However, Montaj uses the video only for analysis — extracting cut timestamps, beat timing, and visual style. The reference audio plays during preview for timing validation but is never included in the final export. No copyrighted content is redistributed. This is transient, analytical use — similar to how search engines cache content for indexing. For a non-commercial student project, the practical enforcement risk is effectively zero. If this were commercialized, I'd switch to requiring users to upload their own files or use official APIs.

## 4-Week Milestones

### Week 1 — Scaffold + upload + basic preview (~10-15 hours)
- Project scaffolded with Next.js + Tailwind and deployed on Vercel
- Upload a reference video manually (saved reel, screen recording, etc.)
- Upload my own photos
- Basic Remotion Player integration — photos display in sequence with fixed timing (e.g., one photo per 2 seconds), reference video viewable for comparison
- No FFmpeg yet — use hardcoded or manually entered cut timestamps to prove the concept

**Demo:** "I upload a reel I like and my travel photos. I manually mark the cut points, and I can preview my photos playing in that rhythm. The auto-extraction isn't there yet, but the concept works."

### Week 2 — FFmpeg extraction + beat sync + yt-dlp (~25-30 hours)
- FFmpeg scene detection extracts cut timestamps automatically (replacing manual input)
- Paste a URL instead of uploading manually (yt-dlp fetches the video server-side), with manual upload as fallback
- Beat detection extracts audio beat timestamps
- Sync validation: show sync score (% of cuts landing on beats)
- Basic reordering UI (swap and move clips)

**Demo:** "I paste a reel link, Montaj auto-extracts the editing pattern and beat-sync score, and I can reorder my photos in the slots."

### Week 3 — Timeline editor + AI matching + transitions (~25-30 hours)
- Full drag-and-drop timeline with @dnd-kit
- AI vision analyzes uploads and auto-matches content to template slots based on content type
- Zoom/pan effects applied per template segment style
- Transitions between clips reflecting the original reel's style
- Sync validation visual timeline with beat/cut markers

**Demo:** "AI matches my photos to the right slots, I can drag-and-drop to rearrange, and the reel has transitions and visual variety."

### Week 4 — AI refinement + captions + export (~25-30 hours)
- AI refinement via natural language ("swap clip 3 for a wider shot", "make the ending longer")
- AI-suggested text overlays and captions
- Export to MP4 without audio, optimized for Instagram Reels, YouTube Shorts, TikTok
- Save and reuse extracted templates
- End-to-end polish
- Bug fixes and basic performance optimization

**Fair demo:** Side-by-side comparison — the original reel that inspired me, and my Montaj reel with the same editing DNA but my own travel content.

---

# Comparison

| | Option A: AI Creative Director | Option B: Reel Remix Engine |
|---|---|---|
| **Core idea** | AI picks, orders, and styles my content from scratch | Reverse-engineer editing patterns from reels I admire |
| **Novelty** | Incremental improvement over existing tools | Genuinely novel — no product does this today |
| **Demo impact** | Strong ("AI made this from my photos") | Stronger ("this feels like that trending reel, but it's mine") |
| **Technical risk** | Lower — straightforward AI + video pipeline | Higher — template extraction is unproven territory |
| **4-week scope** | More achievable — AI selection + beat sync + preview | More ambitious — need scene detection + template matching working |
| **Personal value** | I use it to make reels from scratch | I use it to recreate styles I already admire |

Both options include AI auto-selection and ordering — the AI picks and arranges my content for the first draft either way. The difference is where the "creative direction" comes from: AI's own judgment (Option A) or a reel I point it at (Option B).

**These could also be combined:** Option B as the main feature, with Option A's "AI decides from scratch" mode as a fallback for when I don't have a reference reel. Two entry points: "make it like this" (paste a reel) or "surprise me" (AI decides).

I'd appreciate your thoughts on which direction to focus on — or whether the combined approach is realistic for 4 weeks.
