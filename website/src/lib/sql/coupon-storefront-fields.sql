-- ---------------------------------------------------------------------------
-- OPTIONAL. The offers bar works without this migration.
--
-- WHAT ALREADY EXISTS, AND WHY NO SCHEMA CHANGE WAS REQUIRED.
--
-- The question "may this coupon be advertised on the storefront?" was already
-- answerable before this file existed:
--
--   is_private = false   -> advertise it        (Admin: "Private code — don't
--   is_private = true    -> honour it, hide it   advertise on the store")
--   assigned_email       -> one person's code, never advertised
--   member_scope         -> honoured for one audience, so not advertised to
--                           an anonymous reader
--   active / starts_at / ends_at / max_redemptions -> already the live state
--
-- So "Show in storefront offers ON/OFF" is a switch this store already has,
-- and the offers bar reads it rather than inventing a second one. Nothing
-- below is needed to run a sale.
--
-- WHAT THIS ADDS, IF YOU WANT IT.
--
-- Two conveniences, both nullable, both ignored when absent — the application
-- degrades to the same graceful fallback it uses for is_private and
-- member_scope, so running this is safe and NOT running it changes nothing.
--
--   storefront_headline  Override the generated headline for one coupon.
--                        Leave null and the bar writes "15% OFF sitewide" from
--                        the coupon's own discount_type/discount_value — which
--                        is the safer default, because a hand-typed headline
--                        can be edited out of step with the discount it
--                        describes. Use it for phrasing, never for numbers.
--
--   storefront_priority  Which offer leads when several are public. Lower wins.
--                        Null sorts with the default coupon priority (10).
--
-- RISK: none to pricing. Neither column is read by validateCoupon(), by
-- quote-order.ts, or by anything that computes a total. They affect display
-- ordering and wording only. Both are nullable with no default change, so
-- existing rows are untouched.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table public.coupons
  add column if not exists storefront_headline text,
  add column if not exists storefront_priority integer;

comment on column public.coupons.storefront_headline is
  'Optional display override for the storefront offers bar. Null = generate the headline from discount_type/discount_value. Never affects the discount applied at checkout.';

comment on column public.coupons.storefront_priority is
  'Optional ordering for the storefront offers bar when several public offers are live. Lower sorts first. Null = default coupon priority.';
