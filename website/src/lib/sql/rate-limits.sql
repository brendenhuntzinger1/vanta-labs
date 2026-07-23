-- ============================================================================
-- VANTA LABS — DURABLE RATE LIMITING
-- A shared, serverless-safe rate-limit store (an in-process Map resets on every
-- cold start and doesn't share across instances, so it can't durably limit
-- anything). Each row is one request "hit" in a bucket; the limiter counts hits
-- in a time window. RLS deny-by-default; only the server (service role) writes.
-- Idempotent + safe to re-run.
-- ============================================================================

create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_time_idx
  on public.rate_limit_hits (bucket, created_at desc);

alter table public.rate_limit_hits enable row level security;
-- No policies => deny-by-default for the anon/auth roles; the app uses the
-- service-role key (BYPASSRLS) server-side.
