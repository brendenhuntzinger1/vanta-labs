-- ============================================================================
-- AD REVENUE v3 — a refunded order stops vanishing, and the join keys agree.
--
-- Full DDL with reasoning is src/lib/sql/ads-spend-roas.sql, which was updated
-- in place and remains the single source of truth for the current schema. This
-- file records what was applied to production and when.
--
-- ----------------------------------------------------------------------------
-- TWO DEFECTS, BOTH SILENT, BOTH IN ONE VIEW.
--
-- 1. `payment_status = 'paid'` was the whole filter, and payment-webhook.ts
--    moves a refunded order OUT of that status: 'refunded' on a full refund and
--    'partially_refunded' when the cumulative refund is less than amount_paid
--    (two-step refunds — goods, then shipping — are ordinary here). So the
--    moment any money went back, the order left every ROAS view.
--
--    On a PARTIAL refund that is plainly wrong: the store kept most of the
--    money and the ad still earned it, yet the day's revenue dropped by the
--    WHOLE order and ROAS was understated by the same amount. On a FULL refund
--    it deleted the evidence rather than showing it — `refunds` went to zero
--    too, so a day of refunded sales read exactly like a day with none.
--
--    It also defeated the view's own arithmetic, which was written for this:
--    `amount_paid - refund_amount` already nets a refund to the money kept, and
--    `refunds` already reports what went back. Neither can run on a row the
--    WHERE clause has removed.
--
--    `orders` still counts a refunded order. It WAS a conversion the ad
--    produced, which is how the platforms count it, so CPA and CVR stay
--    comparable with what Meta and TikTok report; the money truth is in
--    net_revenue.
--
-- 2. The two sides of every join were normalised differently and only one of
--    them knew. parseAdTagsFromUrl reads the tags back out of the ad's
--    destination URL and lowercases every value, so ad_spend_daily.utm_content
--    is always lowercase. The ORDER side stores what the browser saw,
--    untouched. An ad built by hand in Meta Ads Manager with
--    `utm_content=Hook_A` therefore produced a spend row keyed `hook_a` against
--    orders keyed `Hook_A`, every join found nothing, and that ad reported
--    ROAS 0.00 with its revenue in none of the blind-spot views either.
--
--    Lowering here repairs the history as well as the future, and changes
--    nothing for a tag the store's own URL builder produced — isSafeTag already
--    requires those to be lowercase.
--
-- ----------------------------------------------------------------------------
-- SAFE TO RE-RUN, AND SAFE TO APPLY BEFORE THE DEPLOY. The column list, order
-- and types are unchanged, so `create or replace` succeeds without touching the
-- five views that select from this one, and each of them inherits both fixes.
-- ============================================================================

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

comment on view public.ad_revenue_daily is
  'Last-touch attributed revenue per day/platform/campaign/creative, derived live from orders in which money was taken (paid, refunded, partially_refunded) with refunds netted inside the sum. Tag values are lowercased to match the ingest, which lowercases them when reading them back out of the ad URL. The finest grain; every ROAS view below re-groups it to its own grain before joining.';
