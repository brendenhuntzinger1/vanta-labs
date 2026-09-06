-- =============================================================================
-- AD SPEND AND ROAS — the missing half of the ads system.
--
-- `ads-system.sql` built `ad_performance_daily`, which holds spend beside
-- site-side revenue per CREATIVE. It has never held a row, because nothing in
-- the codebase writes it and its `creative_id` foreign key requires a creative
-- designed inside this system. Ads that already run on the four live platforms
-- have no creative row, so there was nowhere for their spend to land at all.
--
-- This file adds the layer underneath: raw per-ad daily spend keyed by the
-- platform's OWN ids, with no dependency on `ad_creatives`. That makes spend
-- storable on day one, and revenue joins onto it through UTM tags rather than
-- through a foreign key.
--
-- THREE THINGS ARE DELIBERATE.
--
-- 1. REVENUE IS A VIEW, NOT A TABLE. A revenue table needs a sync job, and a
--    sync job can double-count, lag, or silently stop. Derived straight from
--    `orders` on every read, revenue cannot drift from the money record — and
--    a refund issued three weeks later corrects the original day's ROAS by
--    itself, with nothing to re-run.
--
-- 2. SPEND IS A TABLE, because it is not ours. It comes from four platforms
--    over a network, gets restated for days afterwards, and must survive a
--    failed fetch without losing what already landed.
--
-- 3. PLATFORM-LEVEL ROAS WORKS WITH ZERO SETUP. Per-ad ROAS needs every ad
--    tagged with `utm_content`; platform-level ROAS needs only `utm_source`,
--    which the platforms' own auto-tagging and any sane campaign URL already
--    carry. The owner gets a usable answer before the tagging discipline is
--    complete, instead of an empty dashboard until it is.
--
-- Purely additive. Nothing here modifies orders, payments or any commerce path.
-- Safe to run more than once.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Platform naming — one spelling, decided in one place
-- -----------------------------------------------------------------------------

-- Spend arrives labelled by connector (`facebook`); tags arrive labelled by
-- whatever went in the URL (`meta`, `Facebook`, `fb`). Joining those two
-- directly is the single most likely way for this system to report a real
-- campaign as unattributed, so the mapping is a function rather than a join
-- condition repeated in three views.
--
-- An unrecognised source is returned lowercased rather than mapped to null: an
-- unknown platform is a fact worth seeing in the output, not a row to discard.
create or replace function public.ad_platform_key(raw text)
returns text
language sql
immutable
as $$
  select case lower(btrim(coalesce(raw, '')))
    when ''          then null
    when 'fb'        then 'facebook'
    when 'meta'      then 'facebook'
    when 'facebook'  then 'facebook'
    when 'instagram' then 'facebook'
    when 'ig'        then 'facebook'
    when 'tiktok'    then 'tiktok'
    when 'tt'        then 'tiktok'
    when 'reddit'    then 'reddit'
    when 'snap'      then 'snapchat'
    when 'snapchat'  then 'snapchat'
    else lower(btrim(raw))
  end;
$$;

alter function public.ad_platform_key(text) set search_path = public, pg_temp;
revoke all on function public.ad_platform_key(text) from public;

-- -----------------------------------------------------------------------------
-- 2. Spend — one row per ad per day, per platform
-- -----------------------------------------------------------------------------

create table if not exists public.ad_spend_daily (
  platform        text not null,
  ad_id           text not null,
  stat_date       date not null,

  campaign_id     text,
  campaign_name   text,
  adgroup_id      text,
  adgroup_name    text,
  ad_name         text,

  -- The ad's destination, and the creative tag parsed out of it. Only Meta and
  -- TikTok expose a landing URL through the connector; Reddit and Snapchat do
  -- not, so this is null for those and per-ad revenue there depends on the tag
  -- being discoverable another way. Null means "we could not read it", never
  -- "there wasn't one".
  landing_url     text,
  utm_content     text,

  spend           numeric(12,2) not null default 0,
  impressions     bigint not null default 0,
  clicks          bigint not null default 0,

  -- Stored rather than assumed. Reddit reports USD explicitly; the others
  -- report in the ad account's currency, and a mixed-currency sum presented as
  -- one number would be wrong in a way nobody would notice.
  currency        text not null default 'USD',

  source          text not null default 'windsor',
  ingested_at     timestamptz not null default now(),

  -- The platform's own identity for the row. An ingest that re-fetches the same
  -- day — which it does, every night, because platforms restate — updates in
  -- place instead of adding a second row. Doubled spend is the characteristic
  -- failure of ad reporting pipelines and this key is what forecloses it.
  primary key (platform, ad_id, stat_date)
);

create index if not exists ad_spend_daily_date_idx on public.ad_spend_daily (stat_date desc);
create index if not exists ad_spend_daily_platform_date_idx on public.ad_spend_daily (platform, stat_date desc);
create index if not exists ad_spend_daily_utm_content_idx on public.ad_spend_daily (utm_content) where utm_content is not null;

comment on table public.ad_spend_daily is
  'Raw per-ad daily spend pulled from the ad platforms. Keyed by the platform''s own ad id so it needs no creative row to exist. Upserted on re-fetch; never appended.';

-- -----------------------------------------------------------------------------
-- 3. Revenue — derived from the money record, never stored
-- -----------------------------------------------------------------------------

-- LAST TOUCH, matching how every ad platform reports, so the numbers beside
-- each other are answering the same question. First touch is available on
-- `order_attribution` for the different question of what FINDS customers.
--
-- `payment_status = 'paid'` is load-bearing and not a tidy-up. `amount_paid`
-- is non-zero on failed and cancelled orders in this database — 15 of them
-- carrying $1,527 between them at the time of writing — so a sum without this
-- filter reports revenue the store never took and inflates ROAS accordingly.
--
-- A refund is subtracted on the ORDER's date, not the refund's. That is what
-- makes the ROAS of a given day's spend eventually correct rather than
-- perpetually optimistic: the day that bought the customer is the day that
-- should carry the reversal.
create or replace view public.ad_revenue_daily
with (security_invoker = true) as
select
  (o.created_at at time zone 'UTC')::date        as stat_date,
  public.ad_platform_key(oa.last_utm_source)     as platform,
  oa.last_utm_source                             as utm_source,
  oa.last_utm_campaign                           as utm_campaign,
  oa.last_utm_content                            as utm_content,
  count(*)                                         as orders,
  coalesce(sum(o.refund_amount), 0)::numeric(12,2)  as refunds,
  -- Netted inside the sum, and there is deliberately no `gross_revenue` column
  -- beside it. `ledger-sql-parity.test.ts` forbids any sum of `amount_paid`
  -- that does not net `refund_amount` in the SAME expression, because a gross
  -- figure sitting next to a net one is an invitation to chart the wrong one —
  -- and the wrong one always flatters. Refunds are exposed on their own, which
  -- answers "how much came back" without offering an inflated revenue number.
  --
  -- NOT clamped at zero: `greatest(0, ...)` would report an over-refunded order
  -- as $0 instead of negative, disagreeing with the ledger on exactly the orders
  -- where the store lost money.
  coalesce(sum(o.amount_paid - o.refund_amount), 0)::numeric(12,2) as net_revenue
from public.orders o
join public.order_attribution oa on oa.order_id = o.order_id
where o.payment_status = 'paid'
  and oa.last_utm_source is not null
group by 1, 2, 3, 4, 5;

revoke all on public.ad_revenue_daily from anon, authenticated;

comment on view public.ad_revenue_daily is
  'Last-touch attributed revenue per day/platform/campaign/creative, derived live from orders. Paid orders only.';

-- -----------------------------------------------------------------------------
-- 4. Per-ad ROAS — needs utm_content on every ad
-- -----------------------------------------------------------------------------

-- Inner-joined on the tag, so this view contains exactly the ads whose spend
-- and revenue could actually be tied together. An ad missing from here is not
-- an ad that made nothing; it is an ad that is not tagged, and those two must
-- never render identically. `ad_spend_untagged` below names them explicitly.
create or replace view public.ad_creative_roas_daily
with (security_invoker = true) as
select
  s.platform,
  s.stat_date,
  s.utm_content,
  s.ad_id,
  s.ad_name,
  s.campaign_name,
  s.spend,
  s.impressions,
  s.clicks,
  coalesce(r.orders, 0)      as orders,
  coalesce(r.net_revenue, 0) as net_revenue,
  case when s.impressions > 0 then s.clicks::numeric / s.impressions end as ctr,
  case when s.clicks > 0 then s.spend / s.clicks end                    as cpc,
  case when coalesce(r.orders, 0) > 0 then s.spend / r.orders end        as cpa,
  case when s.spend > 0 then coalesce(r.net_revenue, 0) / s.spend end    as roas
from public.ad_spend_daily s
left join public.ad_revenue_daily r
  on r.platform = s.platform
 and r.stat_date = s.stat_date
 and r.utm_content = s.utm_content
where s.utm_content is not null;

revoke all on public.ad_creative_roas_daily from anon, authenticated;

-- The ads that cannot be measured, and why. Kept as a view so the dashboard can
-- show the size of its own blind spot rather than quietly reporting a subset.
create or replace view public.ad_spend_untagged
with (security_invoker = true) as
select
  s.platform,
  s.stat_date,
  s.ad_id,
  s.ad_name,
  s.campaign_name,
  s.landing_url,
  s.spend,
  case
    when s.landing_url is null then 'no_landing_url_from_platform'
    else 'landing_url_carries_no_utm_content'
  end as reason
from public.ad_spend_daily s
where s.utm_content is null
  and s.spend > 0;

revoke all on public.ad_spend_untagged from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Platform ROAS — works with no tagging at all
-- -----------------------------------------------------------------------------

-- FULL OUTER JOIN, because both halves are informative on their own: spend with
-- no revenue is a platform losing money, and revenue with no spend is either
-- organic traffic wearing a paid tag or — more usefully — a platform whose
-- spend feed has stopped. An inner join would hide both.
create or replace view public.ad_platform_daily
with (security_invoker = true) as
with spend as (
  select platform, stat_date,
         sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks
  from public.ad_spend_daily
  group by 1, 2
),
revenue as (
  select platform, stat_date,
         sum(orders) as orders, sum(net_revenue) as net_revenue
  from public.ad_revenue_daily
  where platform is not null
  group by 1, 2
)
select
  coalesce(s.platform, r.platform)   as platform,
  coalesce(s.stat_date, r.stat_date) as stat_date,
  coalesce(s.spend, 0)::numeric(12,2)       as spend,
  coalesce(s.impressions, 0)                as impressions,
  coalesce(s.clicks, 0)                     as clicks,
  coalesce(r.orders, 0)                     as orders,
  coalesce(r.net_revenue, 0)::numeric(12,2) as net_revenue,
  case when coalesce(s.impressions, 0) > 0 then s.clicks::numeric / s.impressions end as ctr,
  case when coalesce(r.orders, 0) > 0 then s.spend / r.orders end                     as cpa,
  case when coalesce(s.spend, 0) > 0 then coalesce(r.net_revenue, 0) / s.spend end    as roas
from spend s
full outer join revenue r on r.platform = s.platform and r.stat_date = s.stat_date;

revoke all on public.ad_platform_daily from anon, authenticated;

comment on view public.ad_platform_daily is
  'Spend beside attributed revenue per platform per day. The one view that answers "which platform is working" without requiring per-ad UTM tagging.';

-- -----------------------------------------------------------------------------
-- 6. Reddit and Snapchat click ids
-- -----------------------------------------------------------------------------

-- `order_attribution` carried ttclid, fbclid and gclid — TikTok, Meta, Google.
-- Two of the four platforms actually being advertised on had nowhere to put
-- their click id, so the strongest available evidence of a paid click was being
-- dropped at the door. Reddit sends `rdt_cid`; Snapchat sends `ScCid`.
--
-- Nullable, no default, no backfill. Metadata-only, so this is instant and safe
-- to run against a live table.
alter table public.order_attribution
  add column if not exists first_rdt_cid text,
  add column if not exists last_rdt_cid  text,
  add column if not exists first_sccid   text,
  add column if not exists last_sccid    text;

comment on column public.order_attribution.last_rdt_cid is
  'Reddit click id (rdt_cid) from the ad landing URL. Never synthesised: null means the visit carried none.';
comment on column public.order_attribution.last_sccid is
  'Snapchat click id (ScCid) from the ad landing URL. Never synthesised: null means the visit carried none.';

create index if not exists order_attribution_last_rdt_cid_idx
  on public.order_attribution (last_rdt_cid) where last_rdt_cid is not null;
create index if not exists order_attribution_last_sccid_idx
  on public.order_attribution (last_sccid) where last_sccid is not null;

-- -----------------------------------------------------------------------------
-- 7. RLS — deny by default, matching ads-system.sql section 6
-- -----------------------------------------------------------------------------

-- Same reasoning as `ads-system.sql`: this is spend, CPA and ROAS, and the
-- browser must never read it. RLS with no policy leaves only the service-role
-- key, and the revoke disarms Supabase's default grant to anon/authenticated
-- for databases where the default-privilege lockdown has not been applied.
--
-- The views above are `security_invoker` for the same reason spelled out there
-- at length: a view without it runs as its owner, the owner is exempt from its
-- own tables' RLS, and the result would be an unauthenticated read of the
-- store's entire ad spend.
alter table public.ad_spend_daily enable row level security;
revoke all on public.ad_spend_daily from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Verify
-- -----------------------------------------------------------------------------
-- select platform, sum(spend) spend, sum(net_revenue) revenue,
--        round(avg(roas), 2) roas
--   from public.ad_platform_daily
--  where stat_date >= current_date - 30
--  group by 1 order by spend desc;
--
-- select * from public.ad_spend_untagged order by spend desc limit 20;
