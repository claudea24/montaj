# Setup walkthrough — Railway transcode worker

This document is meant to be **opened in a fresh Claude Code session** that
has the Supabase MCP configured. The new session will apply the schema,
help you provision Railway, and verify the queue end-to-end.

If you don't yet have Supabase MCP installed:

```sh
claude mcp add supabase --transport http \
  "https://mcp.supabase.com/mcp?project_ref=uxvqnlfeghyxgxffiukz"
```

Then start `claude` in this repo and follow the prompt in the next section.

---

## Starter prompt for the new session

Copy-paste this into the new Claude Code session as your first message:

> Help me bring the Railway transcode worker online. Read `worker/README.md`
> and `worker/sql/001_transcode_jobs.sql` first.
>
> Steps I want you to do **in order**, stopping for confirmation between
> each:
>
> 1. **Apply the SQL migration via Supabase MCP.** Use the
>    `mcp__supabase__authenticate` tool, then run the contents of
>    `worker/sql/001_transcode_jobs.sql` as a single statement. After it
>    runs, verify with:
>    - `select table_name from information_schema.tables where table_schema='public' and table_name='transcode_jobs';`
>    - `select pg_get_functiondef('public.claim_transcode_job(text)'::regprocedure);`
>    - `select polname, polcmd from pg_policies where tablename='transcode_jobs';`
>    Confirm the table, RPC, and three RLS policies all exist.
>
> 2. **Tell me how to fetch the service-role key.** I'll grab it from
>    Supabase dashboard → Project settings → API → `service_role` secret
>    and paste it as `SUPABASE_SERVICE_ROLE_KEY` later. Do NOT print it
>    back to me or save it to a file.
>
> 3. **Provision Railway.** I have a Railway account. Walk me through:
>    - Creating a new project from the GitHub repo `claudea24/montaj`
>    - Setting the service Root Directory to `worker`
>    - Adding env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
>      and optionally `SUPABASE_BUCKET`, `WORKER_CONCURRENCY`,
>      `WORKER_POLL_INTERVAL_MS`
>    - Deploying. If Railway CLI is the faster path, give me the
>      `railway` commands instead.
>
> 4. **Smoke test the queue.** Once the worker is running on Railway:
>    - Upload a test MOV via the live app at
>      <https://montaj-claudea24.vercel.app> (or have me upload via Bash if
>      simpler).
>    - Insert a synthetic job row via Supabase MCP if no client wiring
>      exists yet. Use my `tmp-demo/hevc/IMG_0963.MOV` if helpful.
>    - Tail Railway logs, watch the job transition `pending → processing → done`.
>    - Verify a new row appears in `public.assets` and a new object lands
>      in `montaj-media`.
>
> 5. **Then move on to Phase B.** Wire the client to use the async path:
>    - Library upload posts to `montaj-media/{user}/{project}/raw/...`
>      instead of going through `/api/transcode-video`.
>    - Insert a `transcode_jobs` row right after upload.
>    - Show a pending-tile state in the library.
>    - Subscribe via Supabase Realtime (or poll every 3s) on
>      `transcode_jobs` rows for the current project; on `done`, refresh
>      the library and find the new asset by `asset_id`.
>    - Decide whether to remove or keep the Vercel `/api/transcode-video`
>      route. I lean toward keeping it as a fallback for now.
>
> Important context:
> - Live URL: `https://montaj-claudea24.vercel.app` (NOT the older
>   `montaj-psi.vercel.app` that some docs still mention).
> - Supabase project ref: `uxvqnlfeghyxgxffiukz`.
> - Storage bucket: `montaj-media`, private, signed URLs (24h TTL).
> - Auth: Clerk. User identity is `auth.jwt()->>'sub'`.
> - Existing `public.touch_updated_at` trigger function is what the
>   migration calls — verify it exists before running the migration.
> - The Vercel transcode route was just rewritten in commit `66fd17a` to
>   use bundled `@ffmpeg-installer/ffmpeg`. Don't unwire that; Railway is
>   meant to replace it, not race with it.

---

## What you need before starting

| Item                                 | Where to get it                                                    |
|--------------------------------------|--------------------------------------------------------------------|
| Supabase MCP installed in Claude     | `claude mcp add supabase ...` (see top of this doc)                |
| Supabase service-role key            | Dashboard → Project settings → API → `service_role` secret         |
| Railway account                      | <https://railway.com> if you don't already have one                 |
| GitHub repo connection to Railway    | First-time setup will OAuth GitHub → grant access to `claudea24/montaj` |
| (Optional) Railway CLI               | `brew install railway` for faster setup vs the dashboard            |

---

## After Phase B ships

When the client async flow is live and Railway has been stable for a few
days, you can:

- Drop `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` from
  `package.json` (saves ~54MB from every Vercel function bundle).
- Delete `src/app/api/transcode-video/route.ts` and the
  `outputFileTracingIncludes` entry in `next.config.ts`.
- Remove `/api/transcode-video` from `src/middleware.ts` public matcher.

Hold on this until you're confident the worker has no edge cases the
Vercel path was covering.
