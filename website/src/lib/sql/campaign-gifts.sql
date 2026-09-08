-- ===========================================================================
-- A BROADCAST CAN NOW CARRY A GIFT.
--
-- WHAT WAS MISSING. `email_automations` has had `offer_key` since the win-back
-- ladder was built: the sweep reads it, mints a one-time offer per recipient,
-- and the checkout honours it. `email_campaigns` never got the column. The only
-- thing a broadcast could carry was `promo_code` — a shared coupon string typed
-- into the copy, with no per-recipient binding, no expiry of its own, no
-- one-per-customer rule and nothing to stop it being pasted into a forum.
--
-- So the thing a broadcast to a subscriber list most wants to do was the thing
-- it could not do safely. Measured on 2026-09-08: 47 opted-in subscribers, 37
-- of them acquired in the previous 48 hours, and not one customer broadcast
-- ever sent.
--
-- TWO COLUMNS, MUTUALLY EXCLUSIVE, BOTH NULLABLE.
--
--   offer_key     names an entry in OFFER_CATALOG — the eleven gifts whose
--                 minimum and expiry were argued about once and written down.
--   offer_custom  a gift the operator built for this campaign: reward kind,
--                 product, quantity, percentage, minimum, lifetime. Validated
--                 by validateCampaignGift() before it is ever stored, and
--                 again at mint time, because a product can be retired between
--                 saving a campaign and sending it.
--
-- The CHECK is what makes "either, or neither, never both" a fact rather than
-- an intention. A campaign carrying both would have two answers to "what did
-- this email promise" and no rule for choosing between them.
--
-- NOTHING ELSE CHANGES. Both default null, so every existing campaign row and
-- every campaign sent before today means exactly what it meant: no gift.
--
-- WHY THE CUSTOM GIFT IS SAFE TO STORE AS JSON. The redemption path never reads
-- it. `customer_offers` records what was promised as COLUMNS — reward_kind,
-- product_slug, percent_off, quantity, min_subtotal_cents, expires_at — and
-- quoteOrder prices from that row under customer_offer_reserve's advisory lock.
-- This column is the TEMPLATE the mint reads once; by the time a customer
-- spends the gift it is an ordinary offer row like every other, subject to the
-- same email binding and the same one-live-offer index.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

alter table if exists public.email_campaigns
  add column if not exists offer_key text;

alter table if exists public.email_campaigns
  add column if not exists offer_custom jsonb;

comment on column public.email_campaigns.offer_key is
  'An OFFER_CATALOG key whose gift is minted per recipient when this campaign sends. Null for a campaign with no gift, or one using offer_custom instead.';

comment on column public.email_campaigns.offer_custom is
  'A gift the operator built for this campaign only: {label, rewardKind, productSlug?, quantity?, percent?, minSubtotalCents, ttlDays}. Validated by validateCampaignGift() on save and again at mint. Null for a campaign with no gift, or one using offer_key instead.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_campaigns_one_gift_source'
  ) then
    alter table public.email_campaigns
      add constraint email_campaigns_one_gift_source
      check (offer_key is null or offer_custom is null);
  end if;
end $$;
