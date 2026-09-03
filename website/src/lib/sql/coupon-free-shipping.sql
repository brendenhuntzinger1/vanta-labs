-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- ONE CODE THAT GIVES A PERCENTAGE **AND** FREE SHIPPING.
--
-- `coupons` has only ever carried `discount_type` of 'percent' or 'fixed' —
-- coupons.ts reads `data.discount_type === "fixed" ? "fixed" : "percent"`, so
-- there has never been a third option — and nothing on the coupon path has ever
-- touched shipping. A code could take money off. It could not waive postage,
-- and it certainly could not do both.
--
-- WHY A FLAG RATHER THAN A THIRD discount_type. A discount type is exclusive:
-- a code is percent OR fixed. Free shipping is not an alternative to a
-- percentage, it is an addition to one, and the whole request was for the two
-- together. Modelling it as a type would have made "15% off AND free shipping"
-- inexpressible for exactly the same reason it is inexpressible today.
--
-- IT DOES NOT JOIN THE DISCOUNT COMPETITION, and that is the point.
-- resolveCustomerDiscount picks a single winner among referral, membership,
-- bulk and coupon, so a coupon's percentage competes and can lose. Shipping is
-- decided by its own expression in quoteOrder, alongside the bulk-savings tier
-- and the membership perk — so a code can waive shipping AND lose the
-- percentage race, and the customer still gets the free shipping they were
-- promised. That is what the words mean to the person reading the email.
--
-- DEFAULT FALSE, so none of the 375 codes already in production starts waiving
-- shipping because this shipped.
alter table if exists public.coupons
  add column if not exists free_shipping boolean not null default false;

comment on column public.coupons.free_shipping is
  'When true this code also waives shipping, in addition to its percent/fixed discount. Independent of the single-best-discount rule — see quote-order.ts.';
