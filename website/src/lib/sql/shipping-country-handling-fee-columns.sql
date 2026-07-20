-- Adds the columns needed for two checkout features:
--   1. A 5% handling fee applied to every order (see calculateHandlingFee
--      in src/lib/shipping.ts).
--   2. Country-aware shipping - flat $15 in the USA (free at $250+), flat
--      $60 international (free at $600+) - see calculateShipping in the
--      same file.
--
-- Run after orders-schema.sql and coupon-checkout-columns.sql. Idempotent -
-- safe to re-run.

alter table if exists public.orders
  add column if not exists country text,
  add column if not exists handling_fee numeric(12,2) not null default 0;
