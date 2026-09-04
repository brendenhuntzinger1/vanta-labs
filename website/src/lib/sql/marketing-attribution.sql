-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- ONE PRIMARY MARKETING SOURCE PER ORDER (2026-09-04).
--
-- Before this, every attribution surface counted the whole order for itself:
-- orders.attributed_campaign_id fed the campaign report, attributed_automation_key
-- fed the automations panel, ambassador_id fed the partner pages, and the cart
-- recovery page counted any paid order by an address with an open cart. One
-- $150 order could appear as $150 of campaign revenue AND $150 of automation
-- revenue AND $150 recovered, and nothing on any page said so. Meanwhile the
-- strongest signal there is — a customer redeeming the private gift token that
-- only one automation email ever carried — credited nothing, because only the
-- click cookie stamped orders.
--
-- So each order now carries ONE primary source, decided by one rule
-- (marketing-source.ts: resolveMarketingSource) and written twice:
--
--   at creation   from the click cookies, the later click winning
--                 (basis 'click');
--   at payment    from everything known once money has arrived — a redeemed
--                 gift token beats a click, then clicks, then a cart-recovery
--                 coupon, then an ambassador code, then an ad touch, else
--                 organic. A click-based stamp is upgraded to the gift's
--                 automation; nothing else is ever moved.
--
-- The existing per-channel columns stay exactly as they are: they are the
-- "assisted" record, and the automations panel shows them as such. Only the
-- primary columns feed a revenue figure, so an order is never two channels'
-- revenue at once.
--
-- Additive: four nullable columns and one partial index. Nothing existing is
-- rewritten except the backfill at the bottom, which fills the kind for paid
-- orders that carry none from what they already record (an ambassador code,
-- a cart-recovery coupon) and calls the rest organic.
-- ---------------------------------------------------------------------------

alter table if exists public.orders
  add column if not exists marketing_source_kind text,
  add column if not exists marketing_source_ref text,
  add column if not exists marketing_source_basis text,
  add column if not exists marketing_source_at timestamptz;

comment on column public.orders.marketing_source_kind is
  'The ONE marketing channel credited with this order: automation | campaign | cart_recovery | ambassador | ad | organic. Decided by resolveMarketingSource (marketing-source.ts); the per-channel attributed_* columns remain as assisted touches.';
comment on column public.orders.marketing_source_ref is
  'What within the channel: the automation key, the campaign id, the recovery coupon code, the ambassador id, the ad campaign/source.';
comment on column public.orders.marketing_source_basis is
  'The evidence: offer_redeemed (a private gift token was spent on this order), click (a tracked email link inside its window), recovery_coupon, referral_code, ad_touch, none.';
comment on column public.orders.marketing_source_at is
  'When the primary source was last decided.';

create index if not exists orders_marketing_source_idx
  on public.orders (marketing_source_kind, marketing_source_ref)
  where marketing_source_kind is not null;

-- Backfill for orders paid before this existed. Same precedence as the
-- runtime rule: a cart-recovery coupon is the stronger claim than a referral
-- code that was stored beside it. They never carried a click
-- stamp (attribution columns are all null in production as of 2026-09-04), so
-- the only evidence is what the order row itself records. Runs once; a row
-- with a kind already set is never touched.
update public.orders o
set marketing_source_kind = case
      when o.attributed_automation_key is not null then 'automation'
      when o.attributed_campaign_id is not null then 'campaign'
      when o.coupon_code is not null and exists (
        select 1 from public.coupons c where c.code = o.coupon_code and c.source = 'cart_recovery'
      ) then 'cart_recovery'
      when o.ambassador_id is not null then 'ambassador'
      else 'organic'
    end,
    marketing_source_ref = case
      when o.attributed_automation_key is not null then o.attributed_automation_key
      when o.attributed_campaign_id is not null then o.attributed_campaign_id::text
      when o.coupon_code is not null and exists (
        select 1 from public.coupons c where c.code = o.coupon_code and c.source = 'cart_recovery'
      ) then o.coupon_code
      when o.ambassador_id is not null then o.ambassador_id::text
      else null
    end,
    marketing_source_basis = case
      when o.attributed_automation_key is not null then 'click'
      when o.attributed_campaign_id is not null then 'click'
      when o.coupon_code is not null and exists (
        select 1 from public.coupons c where c.code = o.coupon_code and c.source = 'cart_recovery'
      ) then 'recovery_coupon'
      when o.ambassador_id is not null then 'referral_code'
      else 'none'
    end,
    marketing_source_at = now()
where o.marketing_source_kind is null
  and o.payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded', 'refunded');
