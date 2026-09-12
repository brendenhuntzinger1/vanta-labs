-- ============================================================================
-- A UTM SOURCE IS NOT AN AD.
--
-- Full DDL with reasoning is src/lib/sql/ads-spend-roas.sql, which remains the
-- single source of truth. This file records what was applied and when.
--
-- ----------------------------------------------------------------------------
-- MEASURED IN PRODUCTION, 2026-09-12. The store had spent $85.23 on TikTok and
-- taken zero orders from it. The Ads tab reported Revenue $286.54, Purchases 2,
-- ROAS 3.36.
--
-- The two "purchases" were ChatGPT referrals. ChatGPT appends
-- `?utm_source=chatgpt.com` to the links it hands out, so those orders arrived
-- carrying a utm_source and nothing else: no utm_medium, no campaign, no
-- creative, no click id. `ad_revenue_daily` asked only that last_utm_source be
-- non-null, and `ad_platform_key()` passes an unrecognised source straight
-- through, so `chatgpt.com` became a platform on the advertising dashboard.
-- `ad_platform_daily` full-outer-joins spend to revenue — deliberately, so a
-- sale on a day with no spend row is not lost — and spend-dashboard.ts builds
-- the headline by summing every platform row. So revenue from a platform the
-- store has never bought an ad on was summed into the headline and divided by
-- TikTok's spend.
--
-- THE RULE. Ad revenue requires a source the store can actually be SPENDING
-- money on: one of the four platforms it buys ads on, or any platform with
-- spend recorded against it. The second clause means connecting a fifth
-- platform needs no change here — money out is the test, not a list somebody
-- has to remember to update.
--
-- NOT DROPPED, NAMED. `ad_revenue_non_paid_source` lists what the exclusion
-- removes, and the Ads tab renders it under "What is not measured". Those
-- orders are real revenue and count in full on the store's own reporting; they
-- simply did not come from an ad. A correction that silently removes $286.54
-- from a dashboard is the kind that gets reverted by whoever notices the drop.
--
-- The same faulty assumption in TypeScript — resolveMarketingSource() treating
-- any utm_source as an ad touch, which stamped two of these orders
-- marketing_source_kind='ad' — is fixed in src/lib/marketing-source.ts against
-- isKnownAdPlatform() in src/lib/ads/utm.ts. That half needs no migration.
--
-- ----------------------------------------------------------------------------
-- NOT YET APPLIED TO PRODUCTION. Verified on the local harness against the
-- production case (2 chatgpt.com orders beside $85.23 of TikTok spend): the
-- headline went from Revenue $286.54 / Purchases 2 / ROAS 3.36 to $0.00 / 0 /
-- 0.00, with the $286.54 named under "What is not measured". Production is
-- read-only to this session by CLAUDE.md's rule, so applying it there is the
-- owner's call. Until it runs, the Ads tab keeps reporting the inflated
-- figures — the TypeScript half of the fix does not correct the views.
--
-- One function added, one view replaced, one view added. The
-- four views built on ad_revenue_daily (ad_platform_daily, ad_campaign_daily,
-- ad_creative_roas_daily, ad_revenue_unattributed) pick the change up
-- unchanged.
--
-- The DB-backed proof is in src/lib/sql/ads-roas-views-executed.test.ts, which
-- runs the shipped file against a real Postgres: $85.23 of TikTok spend beside
-- two chatgpt.com orders now reads 0 purchases, $0.00 revenue and ROAS 0.00,
-- where it read 2, $286.54 and 3.36 before.
-- ============================================================================

create or replace function public.is_paid_ad_source(raw text)
returns boolean
language sql
stable
as $$
  select case
    when public.ad_platform_key(raw) is null then false
    when public.ad_platform_key(raw) in ('facebook', 'tiktok', 'reddit', 'snapchat') then true
    else exists (
      select 1 from public.ad_spend_daily s where s.platform = public.ad_platform_key(raw)
    )
  end;
$$;

alter function public.is_paid_ad_source(text) set search_path = public, pg_temp;
revoke all on function public.is_paid_ad_source(text) from public;

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
  -- The source must be one the store actually buys ads on. See
  -- is_paid_ad_source() above for the production case this closes;
  -- ad_revenue_non_paid_source in section 5 names what it excludes.
  and public.is_paid_ad_source(oa.last_utm_source)
  -- ONE PRIMARY SOURCE PER ORDER, AND THIS VIEW WAS THE ONE THAT IGNORED IT.
  --
  -- marketing-source.ts exists to stop a single order being counted as revenue
  -- by more than one channel: "One $150 order could be $150 of campaign revenue
  -- and $150 of automation revenue and $150 'recovered', and no page said so."
  -- The email dashboard honours it (admin-email.ts filters on
  -- marketing_source_kind = 'campaign'; automation-stats.ts uses 'automation'
  -- for revenue and assistedOrders for a touch that was not primary). Nothing
  -- in this file mentioned it.
  --
  -- So an ad click in September that did not convert, followed three weeks
  -- later by a campaign-email click that did, was $150 of campaign revenue on
  -- the Email tab AND $150 of TikTok revenue against TikTok spend on the Ads
  -- tab — with the 30-day attribution window making that the ordinary case, not
  -- a corner. Every email-driven repeat order inflated paid ROAS, and the
  -- scale-or-kill decision on live budget was made on the inflated number.
  --
  -- Excluded: the three channels that report the same order as their OWN
  -- revenue on another page. `null` still counts, so nothing is lost while
  -- marketing_source_at backfills, and so does 'ad'.
  --
  -- 'ambassador' is deliberately NOT excluded. The one-source rule ranks a
  -- typed referral code above an ad touch, but the ambassador's commission is a
  -- separate ledger by that module's own statement, and an ad that paid for a
  -- click onto an ambassador link is a real ad-driven sale. Which of the two
  -- should carry the revenue is a tagging-policy decision for the owner, not
  -- one to make silently inside a view.
  and (o.marketing_source_kind is null
       or o.marketing_source_kind not in ('campaign', 'automation', 'cart_recovery'))
group by 1, 2, 3, 4, 5;

revoke all on public.ad_revenue_daily from anon, authenticated;

drop view if exists public.ad_revenue_non_paid_source cascade;

create view public.ad_revenue_non_paid_source
with (security_invoker = true) as
select
  (o.created_at at time zone 'UTC')::date as stat_date,
  lower(oa.last_utm_source)               as utm_source,
  count(*)                                as orders,
  coalesce(sum(o.amount_paid - o.refund_amount), 0)::numeric(12,2) as net_revenue
from public.orders o
join public.order_attribution oa on oa.order_id = o.order_id
where o.payment_status in ('paid', 'refunded', 'partially_refunded')
  and oa.last_utm_source is not null
  and not public.is_paid_ad_source(oa.last_utm_source)
  and (o.marketing_source_kind is null
       or o.marketing_source_kind not in ('campaign', 'automation', 'cart_recovery'))
group by 1, 2;

revoke all on public.ad_revenue_non_paid_source from anon, authenticated;

comment on view public.ad_revenue_non_paid_source is
  'Paid orders carrying a utm_source the store does not buy ads on (a referrer that stamps one on outbound links, e.g. chatgpt.com). Deliberately excluded from every ROAS view; surfaced so the exclusion is legible instead of looking like missing revenue.';