-- Profit engine: per-SKU cost + margin fields (admin-only, never shown to
-- customers) plus the store-wide profit-protection defaults.
--
-- Cost/price/margin fields live on products AND product_doses (variant/vial
-- sizes) so a bundle of mixed vials costs out correctly. When a SKU has no
-- stored cost the engine assumes the worst-case unit cost (a Control Center
-- setting; see admin-control.ts getProfitSettings). Idempotent.

alter table if exists public.products
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric;

alter table if exists public.product_doses
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric;

-- Per-order profitability snapshot (for the profit dashboard / reporting). One
-- row per order, written when the order is finalized. Nullable so historical
-- orders backfill lazily.
alter table if exists public.orders
  add column if not exists product_cost_cents integer,
  add column if not exists processing_fee_cents integer,
  add column if not exists shipping_cost_cents integer,
  add column if not exists gross_profit_cents integer,
  add column if not exists gross_margin_percent numeric,
  add column if not exists commission_cost_cents integer;
