-- Private (unlisted) coupons — run once in the Supabase SQL editor.
--
-- A private coupon works normally at checkout for anyone who enters the code,
-- but is NEVER advertised anywhere on the storefront (the promo banner and
-- any customer-facing coupon listing skip it). Use it for codes meant for one
-- person or a small group — e.g. a friend's code, ideally combined with
-- "max redemptions = 1".
--
-- Until this migration runs, coupon creation still works (the app falls back
-- to inserting without the flag) and every coupon behaves as public — same as
-- before. Safe to run more than once.

alter table public.coupons
  add column if not exists is_private boolean not null default false;
