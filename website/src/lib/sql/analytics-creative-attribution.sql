-- =============================================================================
-- Per-creative funnel attribution — additive columns on website_analytics_events
--
-- NOT YET APPLIED.
--
-- Why: the events table carries utm_source, utm_medium and utm_campaign only.
-- utm_content — the field that identifies WHICH creative produced a visit —
-- exists solely on order_attribution, which is written once at order creation.
-- The practical consequence is that per-creative cost-per-acquisition is
-- computable today and per-creative add-to-cart rate is not, because the
-- add_to_cart event has no creative on it. That makes the single most useful
-- diagnostic question in advertising — "strong CTR, weak add-to-cart" —
-- unanswerable, which is exactly the question that separates a creative
-- problem from a landing-page problem.
--
-- Three columns fix it. Nullable, defaulted, no backfill, no rewrite of any
-- existing row. Nothing here touches orders, payments, pricing, inventory,
-- shipping or any commerce path — the analytics table is write-only from the
-- browser and read-only from reporting.
-- =============================================================================

alter table public.website_analytics_events
  add column if not exists utm_content text,
  add column if not exists utm_term    text,
  add column if not exists ttclid      text;

-- utm_content is the creative id. Every per-creative funnel query filters or
-- groups by it, over a date range, so it is indexed with created_at.
create index if not exists website_analytics_events_utm_content_idx
  on public.website_analytics_events (utm_content, created_at desc)
  where utm_content is not null;

-- ttclid joins a session to a TikTok click when the campaign tags are missing
-- or stripped. Partial for the same reason: the overwhelming majority of rows
-- are organic and would only bloat the index.
create index if not exists website_analytics_events_ttclid_idx
  on public.website_analytics_events (ttclid)
  where ttclid is not null;

comment on column public.website_analytics_events.utm_content is
  'Creative identifier from the ad landing URL. Matches ad_creatives.utm_content and order_attribution.first_utm_content/last_utm_content. The join key for per-creative funnel analysis.';
comment on column public.website_analytics_events.utm_term is
  'Ad group identifier from the ad landing URL.';
comment on column public.website_analytics_events.ttclid is
  'TikTok click id appended by the platform at click time. Never synthesised — a null here means the visit carried no click id, which is a fact, not a gap to fill.';

-- -----------------------------------------------------------------------------
-- Verify
-- -----------------------------------------------------------------------------
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'website_analytics_events'
--    and column_name in ('utm_content','utm_term','ttclid')
--  order by column_name;
--
-- Expect three rows, all text, all YES.
