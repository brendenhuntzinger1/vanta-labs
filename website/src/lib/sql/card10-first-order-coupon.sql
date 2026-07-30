-- First-order-only coupons + the CARD10 business-card code — run once in the
-- Supabase SQL editor.
--
-- 1) Adds coupons.first_order_only: a flagged coupon is rejected at checkout
--    for any email that already has a paid order (or an in-flight order that
--    already used the same code) — the same rule the welcome offer enforces.
--    Enforcement lives in src/lib/coupons.ts (validateCoupon).
--
-- 2) Creates CARD10: the code printed on the physical business cards
--    (marketing/business-card/). 10% off, first order only, and PRIVATE —
--    it is never advertised on the storefront, so every CARD10 redemption
--    is a customer who actually scanned/read a card. Count card conversions
--    by filtering orders on coupon_code = 'CARD10'.
--
-- Requires coupon-private-flag.sql (is_private) to have been run first.
-- Until this file runs, coupon creation still works (the app inserts without
-- the flag) and no coupon is treated as first-order-only. Safe to run twice.

alter table public.coupons
  add column if not exists first_order_only boolean not null default false;

insert into public.coupons (code, discount_type, discount_value, active, is_private, first_order_only)
values ('CARD10', 'percent', 10, true, true, true)
on conflict (code) do update
  set active = true,
      discount_value = excluded.discount_value,
      is_private = true,
      first_order_only = true;
