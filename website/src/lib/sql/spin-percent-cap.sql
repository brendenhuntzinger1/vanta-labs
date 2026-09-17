-- ===========================================================================
-- A CEILING ON A PERCENTAGE GIFT.
--
-- WHY. A percentage is the only reward whose cost grows with the basket. A
-- free vial costs its COGS whatever the order is; 20% off costs whatever 20%
-- happens to be, and it costs the most on exactly the orders where the
-- customer was already spending. On this store's p90 order ($319.68) an
-- uncapped 20% gift is $63.94 of margin.
--
-- SHAPE. One nullable integer. Null means "no ceiling", which is precisely how
-- every offer minted before today behaves, so this is a no-op for existing
-- rows and needs no backfill. quote-order.ts reads it only inside the branch
-- that has already computed a percentage, and ignores it when absent.
--
-- RISK: none to an existing order. order_items and orders keep whatever they
-- were priced at; this column is read at quote time only, and a row without it
-- prices exactly as it did before.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

alter table public.customer_offers
  add column if not exists max_discount_cents integer;

comment on column public.customer_offers.max_discount_cents is
  'Ceiling on the cash value of a percentage reward, in cents. Null means uncapped, which is how every row minted before this column behaves. Read by quoteOrder only for the percentage half of a reward.';

-- A ceiling is a positive number or nothing at all. A zero would silently mean
-- "this percentage is worth nothing", which is never what an operator means.
alter table public.customer_offers
  drop constraint if exists customer_offers_max_discount_positive;
alter table public.customer_offers
  add constraint customer_offers_max_discount_positive
  check (max_discount_cents is null or max_discount_cents > 0);
