-- ============================================================================
-- Live visitor tracker — user_id and is_bot on website_analytics_events.
--
-- APPLIED TO PRODUCTION 2026-09-13. This is
-- website-analytics-live-visitor-columns.sql, recorded here now that it has
-- actually run (same pattern as
-- 20260828T0250_analytics_creative_attribution_columns.sql).
--
-- Backs /admin/live (live visitor dashboard). See that file's own header for
-- the full rationale; summary here for the historical record.
--
-- BLAST RADIUS: NONE. Two columns — user_id (nullable uuid FK, on delete set
-- null) and is_bot (boolean not null default false) — both catalogue-only
-- changes on Postgres 17. No existing read or write path referenced either
-- column before this deploy's code shipped. Index built CONCURRENTLY, so no
-- write-blocking lock on a table taking a row per pageview.
--
-- VERIFIED immediately after applying, against project mlpimwgkwuqpsvsrlpqv
-- (the live store's project — confirmed by matching row counts/timestamps
-- against production traffic before touching anything; the empty
-- vanta-audit-harness project was NOT the target):
--
--   user_id  uuid,    nullable, no default   — present
--   is_bot   boolean, not null, default false — present
--   website_analytics_events_live_lookup_idx  indisvalid = true
--   no INVALID index left by the concurrent build
--   anon/authenticated grants on website_analytics_events: still empty
--     (Phase 1 lockdown intact — this migration does not touch grants/RLS)
-- ============================================================================

alter table public.website_analytics_events
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists is_bot  boolean not null default false;

comment on column public.website_analytics_events.user_id is
  'The signed-in customer/ambassador this event belongs to, resolved server-side from the session cookie at write time — never trusted from the client. Null for anonymous activity. Never joined with name/email except at admin-live-visitors.ts read time, for currently-live rows only.';
comment on column public.website_analytics_events.is_bot is
  'Coarse UA-based bot classification (lib/bot-detection.ts), applied at write time. Display filter for /admin/live only — never an access control, never varies what is served.';

-- Run on its own — CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block.
create index concurrently if not exists website_analytics_events_live_lookup_idx
  on public.website_analytics_events (session_id, created_at desc)
  where is_bot = false and event_type in ('heartbeat', 'page_view', 'session_start');

-- ============================================================================
-- ROLLBACK. Only if the feature is abandoned outright — dropping user_id
-- discards which live rows were ever attributable to a signed-in visitor.
--
--   drop index concurrently if exists public.website_analytics_events_live_lookup_idx;
--   alter table public.website_analytics_events
--     drop column if exists user_id,
--     drop column if exists is_bot;
-- ============================================================================
