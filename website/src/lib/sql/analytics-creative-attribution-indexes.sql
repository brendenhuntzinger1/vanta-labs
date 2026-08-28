-- =============================================================================
-- Per-creative attribution indexes — run this SEPARATELY, after
-- analytics-creative-attribution.sql.
--
-- APPLIED TO PRODUCTION 2026-08-28, each statement on its own. Both reported
-- indisvalid = true afterwards; no INVALID index was left behind.
--
-- CONCURRENTLY cannot run inside a transaction block. Run each statement on its
-- own; if your SQL client wraps scripts in a transaction, paste them one at a
-- time. Building concurrently takes longer but never blocks writes, which
-- matters because this table takes a row on every page view.
--
-- Both are partial. The overwhelming majority of rows are organic and carry
-- neither value, so indexing them all would cost write throughput for nothing.
-- =============================================================================

create index concurrently if not exists website_analytics_events_utm_content_idx
  on public.website_analytics_events (utm_content, created_at desc)
  where utm_content is not null;

create index concurrently if not exists website_analytics_events_ttclid_idx
  on public.website_analytics_events (ttclid)
  where ttclid is not null;

-- If a concurrent build fails it leaves an INVALID index behind. Check with:
--   select indexrelid::regclass, indisvalid from pg_index
--    where indrelid = 'public.website_analytics_events'::regclass and not indisvalid;
-- Drop any invalid index and re-run.
