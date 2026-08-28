-- ============================================================================
-- VL-SQL-03 (the time-sensitive half) — utm_content, utm_term and ttclid on
-- website_analytics_events.
--
-- APPLIED TO PRODUCTION 2026-08-28 under the owner's standing SQL
-- authorisation. This is the file `analytics-creative-attribution.sql` plus its
-- indexes, recorded here now that it has actually run.
--
-- ----------------------------------------------------------------------------
-- WHY THIS ONE WAS APPLIED AND ads-system.sql WAS NOT.
--
-- VL-SQL-03 bundles three applies. Only this one is losing data every hour it
-- waits, and only this one is already wired end to end with the write side
-- live. The 13-table ads-system.sql is a FEATURE DEPLOYMENT, dashboard-data.ts
-- degrades cleanly on its absence (42P01), and nothing is lost by it waiting —
-- so it stays an owner decision rather than being swept along with this.
--
-- ----------------------------------------------------------------------------
-- THE DATA WAS ALREADY BEING SENT AND SILENTLY DISCARDED. Verified in source
-- before applying, because a column nothing populates is pointless DDL:
--
--   components/site-analytics-tracker.tsx:99-101
--     utmContent: params.get("utm_content")
--     utmTerm:    params.get("utm_term")
--     ttclid:     params.get("ttclid")
--
--   app/api/analytics/track/route.ts:134-136
--     utm_content: normalizeText(body.utmContent, 180)
--     utm_term:    normalizeText(body.utmTerm, 180)
--     ttclid:      normalizeText(body.ttclid, 260)
--
--   lib/analytics-column-fallback.ts — createOptionalColumnInserter, which
--     retries without the unknown columns when PostgREST answers PGRST204.
--
-- So the browser captured the creative id, the route forwarded it, and the
-- inserter quietly dropped it because the column did not exist. Every ad-driven
-- pageview until now recorded a visit with no idea which creative produced it,
-- and there is no way to recover it afterwards — the click id is not in any
-- other row.
--
-- What this unblocks: per-creative ADD-TO-CART rate. Cost-per-acquisition was
-- already computable from order_attribution, which is written once at order
-- creation; the funnel in between was not, because no mid-funnel event carried
-- a creative. "Strong CTR, weak add-to-cart" is the question that separates a
-- creative problem from a landing-page problem, and it was unanswerable.
--
-- ----------------------------------------------------------------------------
-- BLAST RADIUS: NONE. Three nullable columns with no default, which PostgreSQL
-- adds as a catalogue-only change — no table rewrite, no row touched, instant
-- on a table taking a row per pageview. No commerce path reads or writes this
-- table; it is write-only from the browser relay and read-only from reporting.
--
-- The indexes are built CONCURRENTLY and therefore cannot run inside a
-- transaction block — each was run as its own statement, which is why they are
-- separated below. Both are PARTIAL: the overwhelming majority of rows are
-- organic and carry neither value, so indexing them all would cost write
-- throughput for nothing.
--
-- VERIFIED immediately after applying:
--
--   utm_content / utm_term / ttclid ....... text, nullable, present
--   website_analytics_events_utm_content_idx  indisvalid = true
--   website_analytics_events_ttclid_idx       indisvalid = true
--   no INVALID index left by a failed concurrent build
--   7,429 existing rows, none rewritten
--   anon SELECT false, anon INSERT false  (Phase 1 lockdown intact)
--
--   www.vantalabsresearch.com/                     -> 200
--   www.vantalabsresearch.com/products             -> 200
--   www.vantalabsresearch.com/api/catalog/products -> 200
-- ============================================================================

alter table public.website_analytics_events
  add column if not exists utm_content text,
  add column if not exists utm_term    text,
  add column if not exists ttclid      text;

comment on column public.website_analytics_events.utm_content is
  'Creative identifier from the ad landing URL. Matches ad_creatives.utm_content and order_attribution.first_utm_content/last_utm_content. The join key for per-creative funnel analysis.';
comment on column public.website_analytics_events.utm_term is
  'Ad group identifier from the ad landing URL.';
comment on column public.website_analytics_events.ttclid is
  'TikTok click id appended by the platform at click time. Never synthesised — a null here means the visit carried no click id, which is a fact, not a gap to fill.';

-- RUN EACH OF THE NEXT TWO ON ITS OWN. CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, and most SQL clients wrap a pasted script in one.

create index concurrently if not exists website_analytics_events_utm_content_idx
  on public.website_analytics_events (utm_content, created_at desc)
  where utm_content is not null;

create index concurrently if not exists website_analytics_events_ttclid_idx
  on public.website_analytics_events (ttclid)
  where ttclid is not null;

-- Verification. Both must report indisvalid = true; a failed concurrent build
-- leaves an INVALID index that must be dropped and rebuilt.
select indexrelid::regclass::text as index_name, indisvalid
from pg_index
where indrelid = 'public.website_analytics_events'::regclass
  and indexrelid::regclass::text like '%utm_content%'
   or indexrelid::regclass::text like '%ttclid%';

-- ============================================================================
-- ROLLBACK. Dropping the columns discards whatever creative attribution has
-- been captured since, which is the thing that cannot be recovered — so drop
-- the indexes first and only remove the columns if the feature is abandoned.
--
--   drop index concurrently if exists public.website_analytics_events_utm_content_idx;
--   drop index concurrently if exists public.website_analytics_events_ttclid_idx;
--   alter table public.website_analytics_events
--     drop column if exists utm_content,
--     drop column if exists utm_term,
--     drop column if exists ttclid;
-- ============================================================================
