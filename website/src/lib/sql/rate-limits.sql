-- Distributed, DB-backed rate limiting. A single row per request hit; limits are
-- evaluated with a sliding window count. Works across serverless instances
-- (unlike an in-process Map). Service-role only (no RLS policy = deny to anon).

create table if not exists public.rate_limit_hits (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,          -- "<action>:<identifier>", e.g. "contact:1.2.3.4"
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_limit_bucket_time
  on public.rate_limit_hits(bucket, created_at desc);

alter table public.rate_limit_hits enable row level security;
-- No policies: only the service role (server) can read/write.
