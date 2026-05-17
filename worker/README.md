# Montaj transcode worker

Long-running Node service that drains the `transcode_jobs` queue in Supabase.
Each job downloads the raw upload, transcodes it with `ffmpeg`, uploads the
MP4 back, inserts the `assets` row, and marks the job `done`.

The Vercel route at `src/app/api/transcode-video/route.ts` still exists and
runs the exact same `ffmpeg` arguments — that stays as a fallback for inline
transcodes the client may still trigger. Once Phase B (client async upload
flow) lands, the client will insert a `transcode_jobs` row and let the worker
handle it instead.

## Architecture

```
                   ┌───────────────────────────────┐
client (browser)   │  Supabase Storage             │
    ▲              │   montaj-media/               │
    │              │     {user}/{project}/raw/…    │  ← raw upload
    │              │     {user}/{project}/…mp4     │  ← worker writes here
    │ poll status  │                                │
    ▼              │  Supabase Postgres             │
[ Library shows   →│   public.transcode_jobs        │
  pending / done ] │   public.assets                │
                   └───────────────┬────────────────┘
                                   │ claim_transcode_job() SKIP LOCKED
                                   ▼
                          ┌────────────────┐
                          │ Railway worker │ × N replicas
                          │  ffmpeg + Node │
                          └────────────────┘
```

Multiple replicas (or `WORKER_CONCURRENCY > 1`) all share the same queue.
`SKIP LOCKED` guarantees no two workers ever claim the same job.

## One-time setup

### 1. Apply the SQL migration

Run `worker/sql/001_transcode_jobs.sql` against the Supabase project. Easiest
options:

- **Supabase dashboard** → SQL editor → paste the file → Run.
- **Supabase CLI**: `supabase db execute --file worker/sql/001_transcode_jobs.sql`.
- **MCP**: ask Claude Code to apply it via the Supabase MCP tool.

The migration:
- creates `public.transcode_jobs` with RLS scoped on Clerk's `sub`
- adds an index on the pending queue
- defines `claim_transcode_job(worker text)` (SECURITY DEFINER, granted only
  to `service_role`)

### 2. Mint a Supabase service-role key

The worker uses the **service-role** key (not anon) so it can write to any
user's storage path and bypass RLS for inserting `assets` rows. Get it from:

`Supabase dashboard → Project settings → API → service_role secret`

**Do not commit it.** Treat it like a database password.

### 3. Create the Railway service

```sh
# In the Railway dashboard:
#   New project → Deploy from GitHub repo → claudea24/montaj
#   Root directory: worker
#   (Railway will detect the Dockerfile automatically.)
```

Or via CLI:

```sh
railway init
railway link    # pick the project
railway up      # builds from worker/Dockerfile and deploys
```

### 4. Set env vars on the Railway service

| Variable                       | Required | Notes |
|--------------------------------|----------|-------|
| `SUPABASE_URL`                 | yes      | Same value as `NEXT_PUBLIC_SUPABASE_URL` on Vercel. |
| `SUPABASE_SERVICE_ROLE_KEY`    | yes      | Service-role secret from step 2. |
| `SUPABASE_BUCKET`              | no       | Defaults to `montaj-media`. |
| `WORKER_CONCURRENCY`           | no       | Concurrent jobs per replica (default 2, max 8). |
| `WORKER_POLL_INTERVAL_MS`      | no       | Idle poll interval in ms (default 2000). |
| `RAILWAY_REPLICA_ID`           | auto     | Railway injects this; used for log prefixes. |

For higher throughput, scale the service to multiple replicas in the Railway
dashboard. Each replica pulls from the same queue.

### 5. Smoke test

Insert a job manually against the bucket to confirm the worker drains it:

```sql
insert into public.transcode_jobs (user_id, project_id, name, input_path)
values (
  'user_xxx',                         -- a Clerk userId
  '00000000-0000-0000-0000-000000000000', -- an existing project_id for that user
  'sample.mov',
  'user_xxx/00000000-…/raw/test.mov'  -- a file you uploaded to the bucket
);
```

Watch the Railway logs for `[worker-xxx … ] processing …` followed by
`done → user_xxx/…/sample.mp4`. The job row should flip to `status = 'done'`
and a row should appear in `public.assets`.

## Local dev

The worker also runs locally against the same Supabase project:

```sh
cd worker
npm install
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run dev
```

This is useful when iterating on the ffmpeg arguments — the dev worker drains
the prod queue, so be careful when testing.

## Operational notes

- **Storage layout.** Raw uploads go under `{userId}/{projectId}/raw/…`; the
  worker writes the MP4 to `{userId}/{projectId}/…` (same key without `raw/`,
  extension swapped to `.mp4`) and deletes the raw object on success.
- **Failed jobs.** The worker writes `status = 'failed'` with `error_message`.
  There is no automatic retry; you can re-run by flipping the row back to
  `'pending'`. (Adding bounded retries is a small follow-up.)
- **Idempotency.** The output upload uses `upsert: true`, so retrying a
  failed job that already produced a partial output is safe.
- **Cost.** Railway bills per active container-hour; with `WORKER_CONCURRENCY
  >= 2` you typically want a single small replica unless backlogged.
