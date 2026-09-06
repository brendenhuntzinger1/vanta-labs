-- =============================================================================
-- AD SPEND AND ROAS — the layer that lets revenue be compared against cost.
--
-- `ads-system.sql` built `ad_performance_daily`, which holds spend beside
-- site-side revenue per CREATIVE. It never held a row, because nothing wrote it
-- and its `creative_id` foreign key requires a creative designed inside this
-- system. Ads already running on the four live platforms have no creative row,
-- so their spend had nowhere to land at all.
--
-- This is the layer underneath: raw per-ad daily spend keyed by the platform's
-- OWN ids, with no dependency on `ad_creatives`. Revenue joins to it through UTM
-- tags rather than through a foreign key.
--
-- FIVE THINGS ARE DELIBERATE.
--
-- 1. REVENUE IS A VIEW, NOT A TABLE. A revenue table needs a sync job, and a
--    sync job can double-count, lag, or silently stop. Derived from `orders` on
--    every read, revenue cannot drift from the money record — and a refund
--    issued three weeks later corrects the original day's ROAS by itself.
--
-- 2. SPEND IS A TABLE, because it is not ours. It arrives from four platforms
--    over a network, gets restated for days, and must survive a failed fetch
--    without losing what already landed.
--
-- 3. SPEND IS AGGREGATED TO THE JOIN GRAIN BEFORE REVENUE IS JOINED. This is
--    the single most important rule in the file and section 4 explains what it
--    prevents. Every ROAS view below is `spend grouped to grain X` LEFT JOIN
--    `revenue grouped to grain X`, one row to one row, never a fan-out.
--
-- 4. PLATFORM-REPORTED CONVERSIONS ARE KEPT SEPARATE and are never mixed into
--    ROAS. Each platform counts conversions under its own attribution model
--    (view-through windows, cross-device, its own idea of a purchase) and they
--    will disagree with ours. Storing both and labelling them makes the
--    disagreement visible instead of arbitrary.
--
-- 5. PLATFORM-LEVEL ROAS WORKS WITH NO TAGGING AT ALL. Per-ad ROAS needs every
--    ad tagged with `utm_content`; platform-level needs only `utm_source`. The
--    owner gets a usable answer before the tagging discipline is complete.
--
-- Purely additive. Nothing here modifies orders, payments or any commerce path.
-- Safe to run more than once.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Platform naming — one spelling, decided in one place
-- -----------------------------------------------------------------------------

-- Spend arrives labelled by connector (`facebook`); tags arrive labelled by
-- whatever went into the URL (`meta`, `Facebook`, `fb`). Joining those directly
-- is the most likely way for this system to report a real campaign as
-- unattributed, so the mapping is a function rather than a join condition
-- repeated in four views. Mirrored by adPlatformKey() in src/lib/ads/utm.ts,
-- and spend-aggregate.test.ts pins the two together key for key.
--
-- An unrecognised source is lowercased and returned rather than mapped to null:
-- an unknown platform is a fact worth seeing, not a row to discard.
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

  -- The ad's destination, and the tags parsed out of it. Meta, TikTok and
  -- Reddit all expose a landing URL through the connector; Snapchat does not,
  -- so these stay null there and its ads must be NAMED for their tag instead.
  -- Null means "we could not read it", never "there wasn't one".
  landing_url     text,
  utm_content     text,
  utm_campaign    text,

  spend           numeric(12,2) not null default 0,
  impressions     bigint not null default 0,
  clicks          bigint not null default 0,

  -- THE PLATFORM'S OWN CONVERSION COUNT, never mixed into our ROAS. See the
  -- header, point 4. Nullable on purpose: 0 means the platform reported zero
  -- conversions, null means it reported none at all (no pixel, or the field is
  -- unavailable), and those must stay distinguishable.
  platform_conversions      bigint,
  platform_conversion_value numeric(12,2),

  -- Stored rather than assumed. Reddit reports USD explicitly; the others
  -- report in the ad account's currency, and a mixed-currency sum presented as
  -- one number would be wrong in a way nobody would notice.
  currency        text not null default 'USD',

  source          text not null default 'windsor',
  ingested_at     timestamptz not null default now(),

  -- The platform's own identity for the row. An ingest that re-fetches the same
  -- day — which it does on every run, because platforms restate — updates in
  -- place instead of adding a second row. Doubled spend is the characteristic
  -- failure of ad reporting pipelines and this key is what forecloses it.
  primary key (platform, ad_id, stat_date)
);

-- Added separately so an existing table gains them without a rebuild.
alter table public.ad_spend_daily
  add column if not exists utm_campaign              text,
  add column if not exists platform_conversions      bigint,
  add column if not exists platform_conversion_value numeric(12,2);

create index if not exists ad_spend_daily_date_idx on public.ad_spend_daily (stat_date desc);
create index if not exists ad_spend_daily_platform_date_idx on public.ad_spend_daily (platform, stat_date desc);
create index if not exists ad_spend_daily_utm_content_idx on public.ad_spend_daily (utm_content) where utm_content is not null;
create index if not exists ad_spend_daily_utm_campaign_idx on public.ad_spend_daily (utm_campaign) where utm_campaign is not null;

comment on table public.ad_spend_daily is
  'Raw per-ad daily spend from the ad platforms. Keyed by the platform''s own ad id so it needs no creative row. Upserted on re-fetch; never appended. stat_date is the ad account''s reporting day - see ad_revenue_daily for the timezone note.';

-- -----------------------------------------------------------------------------
-- 3. Revenue — derived from the money record, never stored
-- -----------------------------------------------------------------------------

-- LAST TOUCH, matching how every ad platform reports, so the numbers beside
-- each other answer the same question. First touch stays on `order_attribution`
-- for the different question of what FINDS customers; mixing the two in one
-- number is how a channel gets credited twice.
--
-- `payment_status = 'paid'` is load-bearing and not a tidy-up. `amount_paid` is
-- non-zero on failed and cancelled orders in this database — 15 of them
-- carrying $1,527 between them at the time of writing — so a sum without this
-- filter reports revenue the store never took and inflates ROAS accordingly.
--
-- A refund is subtracted on the ORDER's date, not the refund's, so the day that
-- bought the customer carries its own reversal and its ROAS becomes eventually
-- correct rather than permanently optimistic. Netted inside the sum, with no
-- `gross_revenue` beside it: ledger-sql-parity.test.ts forbids any sum of
-- amount_paid that does not net refund_amount in the same expression, and a
-- gross figure sitting next to a net one is an invitation to chart the wrong
-- one. NOT clamped at zero — an over-refunded order must stay negative or it
-- disagrees with the ledger exactly where the store lost money.
--
-- TIMEZONE. Orders are bucketed by UTC day; `ad_spend_daily.stat_date` is the
-- day the ad account reports in, which for these four accounts is not
-- guaranteed to be UTC. A purchase near midnight can therefore land one day
-- either side of the spend that produced it. That is a real limit and it is
-- accepted rather than hidden: it moves single-day rows, and it does not move a
-- 30-day total except at the two window edges, which is why the dashboard leads
-- with a window total and treats the daily series as a trend rather than a
-- ledger. Do not "fix" this by shifting one side without the other.
-- A REFUNDED ORDER IS STILL AN ORDER, AND A PARTIAL REFUND IS MOSTLY REVENUE.
--
-- `payment_status = 'paid'` was the whole filter, and payment-webhook.ts moves a
-- refunded order OUT of that status: 'refunded' on a full refund, and
-- 'partially_refunded' when the cumulative refund is less than amount_paid
-- (two-step refunds — goods, then shipping — are ordinary practice here). So
-- the moment any money went back, the order left these views entirely.
--
-- On a PARTIAL refund that is plainly wrong: the store kept most of the money
-- and the ad still earned it, but the day's revenue dropped by the whole order
-- and ROAS was understated by the same amount. On a FULL refund it silently
-- deleted the evidence instead of showing it: `refunds` went to zero too, so a
-- day of refunded sales read identically to a day with none.
--
-- It also defeated the arithmetic directly above, which was written for exactly
-- this: `amount_paid - refund_amount` already nets a refund to the money the
-- store kept, and `refunds` already reports what went back. Neither can run on
-- a row the WHERE clause has removed. The three statuses below are the ones in
-- which money was actually taken; the netting does the rest.
--
-- `orders` deliberately still counts a refunded order. It WAS a conversion the
-- ad produced, which is how the ad platforms count it too, so CPA and CVR stay
-- comparable with what Meta and TikTok report. The money truth lives in
-- net_revenue.
--
-- LOWERCASED JOIN KEYS, because the two sides were normalised differently and
-- only one of them knew. parseAdTagsFromUrl reads the tags back out of the ad's
-- destination URL and lowercases every value, so ad_spend_daily.utm_content is
-- always lowercase. The ORDER side stores what the browser saw, untouched. An
-- ad built by hand in Meta Ads Manager with `utm_content=Hook_A` therefore
-- produced a spend row keyed `hook_a` and orders keyed `Hook_A`, the join in
-- every view below found nothing, and that ad reported ROAS 0.00 with its
-- revenue appearing in none of the blind-spot views either. Lowering here fixes
-- the history as well as the future, and changes nothing for a tag the store's
-- own URL builder produced, which isSafeTag already requires to be lowercase.
create or replace view public.ad_revenue_daily
with (security_invoker = true) as
select
  (o.created_at at time zone 'UTC')::date        as stat_date,
  public.ad_platform_key(oa.last_utm_source)     as platform,
  lower(oa.last_utm_source)                      as utm_source,
  lower(oa.last_utm_campaign)                    as utm_campaign,
  lower(oa.last_utm_content)                     as utm_content,
  count(*)                                       as orders,
  coalesce(sum(o.refund_amount), 0)::numeric(12,2) as refunds,
  coalesce(sum(o.amount_paid - o.refund_amount), 0)::numeric(12,2) as net_revenue
from public.orders o
join public.order_attribution oa on oa.order_id = o.order_id
where o.payment_status in ('paid', 'refunded', 'partially_refunded')
  and oa.last_utm_source is not null
group by 1, 2, 3, 4, 5;

revoke all on public.ad_revenue_daily from anon, authenticated;

comment on view public.ad_revenue_daily is
  'Last-touch attributed revenue per day/platform/campaign/creative, derived live from orders in which money was taken (paid, refunded, partially_refunded) with refunds netted inside the sum. Tag values are lowercased to match the ingest, which lowercases them when reading them back out of the ad URL. The finest grain; every ROAS view below re-groups it to its own grain before joining.';

-- -----------------------------------------------------------------------------
-- 4. ROAS at three grains — spend aggregated to the grain FIRST
-- -----------------------------------------------------------------------------

-- WHY EVERY VIEW BELOW STARTS WITH A GROUP BY, and what it prevents.
--
-- `ad_spend_daily` is one row per AD. `ad_revenue_daily` is one row per
-- (platform, day, campaign, creative). Those grains are not the same, and
-- joining them directly fans out: two ads sharing one `utm_content` on the same
-- platform and day would EACH match the single revenue row, and summing the
-- result reports that creative's revenue twice. Three ads, three times. The
-- error scales with how sensibly the ads are tagged, so it would appear exactly
-- when the tagging discipline started working.
--
-- The fix is structural rather than careful: reduce spend to precisely the
-- revenue key, then join one row to one row. Applied identically at all three
-- grains so none of them can drift into the fan-out.

drop view if exists public.ad_creative_roas_daily cascade;
drop view if exists public.ad_campaign_daily cascade;
drop view if exists public.ad_platform_daily cascade;
drop view if exists public.ad_spend_untagged cascade;
drop view if exists public.ad_revenue_unattributed cascade;

-- PER CREATIVE. Inner-joined on the tag, so this contains exactly the ads whose
-- spend and revenue can be tied together. An ad missing from here is not an ad
-- that made nothing; it is an ad that is not tagged, and `ad_spend_untagged`
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
select
  s.platform, s.stat_date, s.utm_content, s.ad_name, s.campaign_name, s.ads,
  s.spend, s.impressions, s.clicks,
  s.platform_conversions,
  coalesce(r.orders, 0)      as orders,
  coalesce(r.net_revenue, 0) as net_revenue,
  coalesce(r.refunds, 0)     as refunds,
  case when s.impressions > 0 then s.clicks::numeric / s.impressions end       as ctr,
  case when s.clicks > 0 then s.spend / s.clicks end                           as cpc,
  case when s.impressions > 0 then (s.spend / s.impressions) * 1000 end        as cpm,
  case when s.clicks > 0 then coalesce(r.orders, 0)::numeric / s.clicks end    as cvr,
  case when coalesce(r.orders, 0) > 0 then s.spend / r.orders end              as cpa,
  case when s.spend > 0 then coalesce(r.net_revenue, 0) / s.spend end          as roas
from spend s
left join revenue r
  on r.platform = s.platform and r.stat_date = s.stat_date and r.utm_content = s.utm_content;

revoke all on public.ad_creative_roas_daily from anon, authenticated;

-- PER CAMPAIGN. Both sides key on the UTM campaign tag, not on the platform's
-- own campaign name. Those are different strings — one is typed into the URL,
-- the other into the ad platform — and joining them would report every campaign
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
select
  s.platform, s.stat_date, s.utm_campaign, s.campaign_name,
  s.spend, s.impressions, s.clicks, s.platform_conversions,
  coalesce(r.orders, 0)      as orders,
  coalesce(r.net_revenue, 0) as net_revenue,
  case when s.impressions > 0 then s.clicks::numeric / s.impressions end       as ctr,
  case when s.clicks > 0 then s.spend / s.clicks end                           as cpc,
  case when s.impressions > 0 then (s.spend / s.impressions) * 1000 end        as cpm,
  case when s.clicks > 0 then coalesce(r.orders, 0)::numeric / s.clicks end    as cvr,
  case when coalesce(r.orders, 0) > 0 then s.spend / r.orders end              as cpa,
  case when s.spend > 0 then coalesce(r.net_revenue, 0) / s.spend end          as roas
from spend s
left join revenue r
  on r.platform = s.platform and r.stat_date = s.stat_date and r.utm_campaign = s.utm_campaign;

revoke all on public.ad_campaign_daily from anon, authenticated;

-- PER PLATFORM. The one view that needs no tagging beyond `utm_source`, which
-- is why the dashboard leads with it.
--
-- FULL OUTER JOIN, because both halves are informative alone: spend with no
-- revenue is a platform losing money, and revenue with no spend is either
-- organic traffic wearing a paid tag or — more usefully — a platform whose
-- spend feed has stopped. An inner join would hide both.
create view public.ad_platform_daily
with (security_invoker = true) as
with spend as (
  select platform, stat_date,
         sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
         sum(platform_conversions) as platform_conversions,
         sum(platform_conversion_value) as platform_conversion_value
  from public.ad_spend_daily
  group by 1, 2
),
revenue as (
  select platform, stat_date,
         sum(orders) as orders, sum(net_revenue) as net_revenue, sum(refunds) as refunds
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
  s.platform_conversions,
  s.platform_conversion_value,
  coalesce(r.orders, 0)                     as orders,
  coalesce(r.net_revenue, 0)::numeric(12,2) as net_revenue,
  coalesce(r.refunds, 0)::numeric(12,2)     as refunds,
  case when coalesce(s.impressions, 0) > 0 then s.clicks::numeric / s.impressions end    as ctr,
  case when coalesce(s.clicks, 0) > 0 then s.spend / s.clicks end                        as cpc,
  case when coalesce(s.impressions, 0) > 0 then (s.spend / s.impressions) * 1000 end     as cpm,
  case when coalesce(s.clicks, 0) > 0 then coalesce(r.orders, 0)::numeric / s.clicks end as cvr,
  case when coalesce(r.orders, 0) > 0 then s.spend / r.orders end                        as cpa,
  case when coalesce(s.spend, 0) > 0 then coalesce(r.net_revenue, 0) / s.spend end       as roas
from spend s
full outer join revenue r on r.platform = s.platform and r.stat_date = s.stat_date;

revoke all on public.ad_platform_daily from anon, authenticated;

comment on view public.ad_platform_daily is
  'Spend beside attributed revenue per platform per day. The one view that answers "which platform is working" without requiring per-ad UTM tagging.';

-- -----------------------------------------------------------------------------
-- 5. The two blind spots, named rather than dropped
-- -----------------------------------------------------------------------------

-- SPEND WE CANNOT MEASURE: money went out against an ad carrying no readable
-- creative tag. Its spend is still counted in the platform totals; only its
-- sales cannot be traced. A ROAS table that quietly covers 60% of spend is
-- worse than one that says which 40% is missing.
create view public.ad_spend_untagged
with (security_invoker = true) as
select
  platform, stat_date, ad_id, ad_name, campaign_name, landing_url, spend,
  case
    when landing_url is null then 'no_landing_url_from_platform'
    else 'landing_url_carries_no_utm_content'
  end as reason
from public.ad_spend_daily
where utm_content is null
  and spend > 0;

revoke all on public.ad_spend_untagged from anon, authenticated;

-- REVENUE WE CANNOT PLACE: a paid order that names a platform but no creative,
-- so it counts toward that platform's ROAS and toward nothing finer. Surfaced
-- so the per-ad table's shortfall against the platform table has a stated cause
-- rather than looking like arithmetic that does not add up.
create view public.ad_revenue_unattributed
with (security_invoker = true) as
select
  platform, stat_date, utm_source, utm_campaign,
  sum(orders) as orders, sum(net_revenue) as net_revenue
from public.ad_revenue_daily
where utm_content is null
group by 1, 2, 3, 4;

revoke all on public.ad_revenue_unattributed from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Reddit and Snapchat click ids
-- -----------------------------------------------------------------------------

-- `order_attribution` carried ttclid, fbclid and gclid — TikTok, Meta, Google.
-- Two of the four platforms actually being advertised on had nowhere to put
-- their click id, so the strongest available evidence of a paid click was
-- dropped at the door. Reddit sends `rdt_cid`; Snapchat sends `ScCid`.
--
-- Nullable, no default, no backfill: metadata-only, so this is instant and safe
-- against a live table.
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

-- This is spend, CPA and ROAS: the browser must never read it. RLS with no
-- policy leaves only the service-role key, and the revoke disarms Supabase's
-- default grant to anon/authenticated for databases where the default-privilege
-- lockdown has not been applied.
--
-- The views are `security_invoker` for the reason ads-system.sql spells out at
-- length: a view without it runs as its owner, the owner is exempt from its own
-- tables' RLS, and the result is an unauthenticated read of the store's entire
-- ad spend.
alter table public.ad_spend_daily enable row level security;
revoke all on public.ad_spend_daily from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Verify
-- -----------------------------------------------------------------------------
-- select platform, sum(spend) spend, sum(net_revenue) revenue
--   from public.ad_platform_daily where stat_date >= current_date - 30
--  group by 1 order by spend desc;
--
-- -- The fan-out guard: this must return zero rows. If it ever does not, a ROAS
-- -- view is joining revenue to un-aggregated spend again.
-- select platform, stat_date, utm_content, count(*)
--   from public.ad_creative_roas_daily
--  group by 1,2,3 having count(*) > 1;
--
-- select * from public.ad_spend_untagged order by spend desc limit 20;
-- select * from public.ad_revenue_unattributed order by net_revenue desc limit 20;
