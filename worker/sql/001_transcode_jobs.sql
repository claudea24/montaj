-- Transcode jobs queue. Inserted by the client (via Vercel or directly with
-- the anon key under RLS); claimed by the Railway worker(s) using the
-- service-role key. The `claim_transcode_job` RPC uses FOR UPDATE SKIP
-- LOCKED so multiple workers can pull different jobs in parallel without
-- claiming the same row.

create table if not exists public.transcode_jobs (
  id                uuid        primary key default gen_random_uuid(),
  user_id           text        not null,
  project_id        uuid        not null
                                references public.projects(id) on delete cascade,
  asset_id          uuid        references public.assets(id) on delete set null,
  name              text        not null,
  -- Storage key for the raw upload (e.g. "{userId}/{projectId}/raw/{uuid}-name.mov").
  input_path        text        not null,
  -- Storage key for the finished MP4. Null until status = 'done'.
  output_path       text,
  status            text        not null default 'pending'
                                check (status in ('pending','processing','done','failed')),
  error_message     text,
  attempts          int         not null default 0,
  worker_id         text,
  claimed_at        timestamptz,
  duration_seconds  double precision,
  width             int,
  height            int,
  metadata          jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_transcode_jobs_pending
  on public.transcode_jobs (created_at)
  where status = 'pending';

create index if not exists idx_transcode_jobs_owner
  on public.transcode_jobs (user_id, created_at desc);

-- Reuse the existing public.touch_updated_at trigger function (installed for
-- projects/assets). If you renamed it, swap the name here.
drop trigger if exists touch_transcode_jobs_updated_at on public.transcode_jobs;
create trigger touch_transcode_jobs_updated_at
  before update on public.transcode_jobs
  for each row execute function public.touch_updated_at();

-- RLS — clients can see/insert their own jobs; the worker uses the
-- service-role key which bypasses RLS.
alter table public.transcode_jobs enable row level security;

drop policy if exists "transcode_jobs select own" on public.transcode_jobs;
create policy "transcode_jobs select own"
  on public.transcode_jobs
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "transcode_jobs insert own" on public.transcode_jobs;
create policy "transcode_jobs insert own"
  on public.transcode_jobs
  for insert
  to authenticated
  with check ((select auth.jwt()->>'sub') = user_id);

-- Clients should not mutate jobs after creation; the worker handles status
-- transitions. (No update or delete policies.)

-- Atomic job claim. Returns the claimed row, or no rows if the queue is
-- empty. SKIP LOCKED lets parallel workers race without conflict.
create or replace function public.claim_transcode_job(worker text)
returns setof public.transcode_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed transcode_jobs%rowtype;
begin
  update public.transcode_jobs
     set status     = 'processing',
         worker_id  = worker,
         claimed_at = now(),
         attempts   = attempts + 1
   where id = (
         select id
           from public.transcode_jobs
          where status = 'pending'
          order by created_at
          limit 1
          for update skip locked
       )
   returning * into claimed;

  if found then
    return next claimed;
  end if;
  return;
end;
$$;

-- Lock the RPC down. Only the service-role key (worker) may call it.
revoke all on function public.claim_transcode_job(text) from public;
revoke all on function public.claim_transcode_job(text) from anon;
revoke all on function public.claim_transcode_job(text) from authenticated;
grant execute on function public.claim_transcode_job(text) to service_role;
