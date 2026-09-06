-- ============================================================================
-- AD ROAS v4 — a sale that lands the day after the click stops disappearing.
--
-- Full DDL with reasoning is src/lib/sql/ads-spend-roas.sql, which was updated
-- in place and remains the single source of truth. This file records what was
-- applied to production and when.
--
-- ----------------------------------------------------------------------------
-- REVENUE ARRIVES ON THE DAY OF THE ORDER; SPEND ON THE DAY OF THE CLICK.
--
-- Those are routinely different days: a click at 23:00 that converts at 00:30,
-- an ad paused mid-flight that keeps converting, or simply the offset between
-- the ad account's reporting day and UTC. Every one of them produced a revenue
-- row with no spend row to join to, and the LEFT join from spend dropped it.
--
-- The platform grain already used a FULL join and was therefore correct. The
-- creative and campaign grains — the two the owner actually reads to decide
-- which ad to scale — did not.
--
-- MEASURED on a real Postgres: $100 spent on 2026-08-20 against `lag_hook`,
-- one $400 order attributed to it on 2026-08-21.
--
--     ad_platform_daily         2026-08-20  spend 100  revenue 0
--                               2026-08-21  spend 0    revenue 400   correct
--     ad_creative_roas_daily    2026-08-20  spend 100  revenue 0     the only row
--
-- The $400 appeared nowhere at the creative grain, so that ad reported ROAS
-- 0.000 over the window. Winners and Losers are ranked by ROAS, so an ad
-- returning 4x was presented to the owner as the store's worst performer —
-- a decision-grade error, in the direction that kills a winning ad.
--
-- Both views now FULL join, with coalesced keys so a revenue-only row still
-- carries its platform, day and tag. Spend-derived columns are zero or null on
-- such a row and every ratio is guarded, so ROAS on a no-spend day is NULL
-- rather than a division by zero.
--
-- These are `create view` (not `create or replace`): the column expressions
-- change, so each is dropped and recreated. Nothing selects from them in the
-- database — the dashboard reads them from the application — so the drop is
-- safe. Both are re-revoked from anon and authenticated in the same statement
-- block, exactly as the source file does.
-- ============================================================================

drop view if exists public.ad_creative_roas_daily cascade;
drop view if exists public.ad_campaign_daily cascade;

-- names those explicitly so the two never render alike.
create view public.ad_creative_roas_daily
with (security_invoker = true) as
with spend as (
  select
    platform, stat_date, utm_content,
    sum(spend)                     as spend,
    sum(impressions)               as impressions,
    sum(clicks)                    as clicks,
    sum(platform_conversions)      as platform_conversions,
    count(*)                       as ads,
    min(ad_name)                   as ad_name,
    min(campaign_name)             as campaign_name
  from public.ad_spend_daily
  where utm_content is not null
  group by 1, 2, 3
),
revenue as (
  select platform, stat_date, utm_content,
         sum(orders) as orders, sum(net_revenue) as net_revenue, sum(refunds) as refunds
  from public.ad_revenue_daily
  where utm_content is not null
  group by 1, 2, 3
)
-- FULL JOIN, for the same reason the platform grain below already uses one:
-- BOTH HALVES ARE INFORMATIVE ALONE, and a LEFT join from spend threw one of
-- them away silently.
--
-- Revenue arrives on the day of the ORDER; spend on the day of the CLICK. They
-- are routinely different days — a click at 23:00 that converts at 00:30, an ad
-- paused mid-flight that keeps converting, or simply the offset between the ad
-- account's reporting day and UTC. Every one of those produced a revenue row
-- with no spend row to join to, and a LEFT join from spend dropped it.
--
-- Measured on the harness: $100 spent on 2026-08-20 on `lag_hook`, one $400
-- order attributed to it on 2026-08-21. The platform grain showed both days
-- correctly. This view showed ONE row — spend 100, revenue 0, ROAS 0.000 — and
-- the $400 appeared nowhere. Because the dashboard ranks Winners and Losers by
-- ROAS, that ad was listed as the store's worst performer while actually
-- returning 4x, which is a decision-grade error: the owner kills it.
--
-- Keys are coalesced so a revenue-only row still carries its platform, day and
-- tag. Spend-derived columns stay null on such a row and every ratio is already
-- guarded, so ROAS on a no-spend day is null rather than a division by zero.
select
  coalesce(s.platform, r.platform)     as platform,
  coalesce(s.stat_date, r.stat_date)   as stat_date,
  coalesce(s.utm_content, r.utm_content) as utm_content,
  s.ad_name, s.campaign_name, s.ads,
  coalesce(s.spend, 0)       as spend,
  coalesce(s.impressions, 0) as impressions,
  coalesce(s.clicks, 0)      as clicks,
  s.platform_conversions,
  coalesce(r.orders, 0)      as orders,
  coalesce(r.net_revenue, 0) as net_revenue,
  coalesce(r.refunds, 0)     as refunds,
  case when coalesce(s.impressions, 0) > 0 then s.clicks::numeric / s.impressions end       as ctr,
  case when coalesce(s.clicks, 0) > 0 then s.spend / s.clicks end                           as cpc,
  case when coalesce(s.impressions, 0) > 0 then (s.spend / s.impressions) * 1000 end        as cpm,
  case when coalesce(s.clicks, 0) > 0 then coalesce(r.orders, 0)::numeric / s.clicks end    as cvr,
  case when coalesce(r.orders, 0) > 0 and coalesce(s.spend, 0) > 0 then s.spend / r.orders end as cpa,
  case when coalesce(s.spend, 0) > 0 then coalesce(r.net_revenue, 0) / s.spend end          as roas
from spend s
full join revenue r
  on r.platform = s.platform and r.stat_date = s.stat_date and r.utm_content = s.utm_content;

revoke all on public.ad_creative_roas_daily from anon, authenticated;

-- as unattributed unless the owner happened to name them identically.
create view public.ad_campaign_daily
with (security_invoker = true) as
with spend as (
  select
    platform, stat_date, utm_campaign,
    sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
    sum(platform_conversions) as platform_conversions,
    min(campaign_name) as campaign_name
  from public.ad_spend_daily
  where utm_campaign is not null
  group by 1, 2, 3
),
revenue as (
  select platform, stat_date, utm_campaign,
         sum(orders) as orders, sum(net_revenue) as net_revenue
  from public.ad_revenue_daily
  where utm_campaign is not null
  group by 1, 2, 3
)
-- FULL JOIN for the same reason as the creative grain above: an order placed
-- the day after the click had no spend row to join to and vanished.
select
  coalesce(s.platform, r.platform)         as platform,
  coalesce(s.stat_date, r.stat_date)       as stat_date,
  coalesce(s.utm_campaign, r.utm_campaign) as utm_campaign,
  s.campaign_name,
  coalesce(s.spend, 0)       as spend,
  coalesce(s.impressions, 0) as impressions,
  coalesce(s.clicks, 0)      as clicks,
  s.platform_conversions,
  coalesce(r.orders, 0)      as orders,
  coalesce(r.net_revenue, 0) as net_revenue,
  case when coalesce(s.impressions, 0) > 0 then s.clicks::numeric / s.impressions end       as ctr,
  case when coalesce(s.clicks, 0) > 0 then s.spend / s.clicks end                           as cpc,
  case when coalesce(s.impressions, 0) > 0 then (s.spend / s.impressions) * 1000 end        as cpm,
  case when coalesce(s.clicks, 0) > 0 then coalesce(r.orders, 0)::numeric / s.clicks end    as cvr,
  case when coalesce(r.orders, 0) > 0 and coalesce(s.spend, 0) > 0 then s.spend / r.orders end as cpa,
  case when coalesce(s.spend, 0) > 0 then coalesce(r.net_revenue, 0) / s.spend end          as roas
from spend s
full join revenue r
  on r.platform = s.platform and r.stat_date = s.stat_date and r.utm_campaign = s.utm_campaign;

revoke all on public.ad_campaign_daily from anon, authenticated;
