-- ============================================================================
-- VANTA LABS — COMPLETE THE COGS LOCKDOWN: THE DOSE IS THE SELLABLE UNIT
-- Paste into: Supabase -> SQL Editor -> New query -> Run. Safe to re-run.
--
-- APPLIED TO PRODUCTION 2026-08-27 (final integration pass), together with
-- products-hide-cost-columns-from-public.sql.
--
-- WHY THIS FILE EXISTS. The launch-audit migration
-- (products-hide-cost-columns-from-public.sql) closed finding A2 on
-- public.products. It did not cover public.product_doses — and the dose row,
-- not the parent, is what a customer actually buys and where the real landed
-- cost is kept. Probed with the storefront's OWN publishable key AFTER the
-- products migration had been applied:
--
--   GET /rest/v1/product_doses?select=*   ->  200, 49 of 49 rows carrying
--                                             product_cost_cents
--
--     5mg    retail $ 49.99   cost $ 4.38    91.2% margin
--     10mg   retail $ 69.99   cost $ 6.13    91.2% margin
--     20mg   retail $119.99   cost $ 9.63    92.0% margin
--     30mg   retail $144.99   cost $12.80    91.2% margin
--
-- These are strictly MORE sensitive than the parent figures already revoked:
-- the parent rows advertised a flat $35.00, the dose rows give the true
-- per-variant cost and therefore the real margin on every SKU in the catalogue.
--
-- WHAT IS AND IS NOT WRONG. Identical to the products case. The RLS policy
-- product_doses_select_public gets the ROW filter right — it joins to the
-- parent and requires is_active AND is_enabled AND is_published AND NOT
-- is_archived. Postgres RLS cannot express "these rows, but not those
-- columns", so the policy is left exactly as it is and the column scope is
-- fixed with GRANTs, which is the mechanism that can say it.
--
-- WHY THIS BREAKS NOTHING. Every read of product_doses in the app runs
-- server-side under service_role: catalog.ts (the public catalogue),
-- api/cart/validate, admin-products, admin-coa, admin-inventory,
-- inventory-fulfillment, inventory-reservation, shippo/service, system-status.
-- The catalogue that the storefront renders comes from /api/catalog/products,
-- whose dose projection is id/label/price/stock only — it has never selected a
-- cost column. The single browser-side reference is a realtime
-- postgres_changes subscription in app/admin/products/page.tsx, and the
-- supabase_realtime publication contains NO tables in this project, so that
-- subscription delivers nothing either way.
-- ============================================================================

begin;

-- Table-level SELECT outranks any per-column grant, so it has to go first or
-- the GRANT below is decoration.
revoke select on public.product_doses from anon, authenticated;

-- Everything a storefront legitimately renders for a variant. Deliberately
-- enumerated: a future column is NOT readable by the public until someone adds
-- it here and says why.
grant select (
  id,
  product_id,
  label,
  slug_suffix,
  sku,
  -- Price presentation.
  price_cents,
  compare_at_price_cents,
  sale_price_cents,
  -- Stock presentation, the derived half only: stock_status is the In Stock /
  -- Low stock badge, track_inventory is a boolean that discloses no depth.
  --
  -- The raw quantities are NOT granted -- see the products migration for the
  -- full reasoning. In short: the availability figure the public catalogue
  -- publishes is clamped to MAX_UNITS_PER_ORDER_LINE (catalog.ts), so the
  -- application deliberately caps what a reader of the page source learns,
  -- while this grant handed over the uncapped count. The dose row is the
  -- sellable unit, so its depth is the number that matters.
  stock_status,
  track_inventory,
  -- Compliance and lab documentation, public on purpose.
  batch_number,
  coa_url,
  image_url,
  purity_result,
  -- Variant selection.
  is_default,
  is_enabled,
  position,
  shipping_weight_oz,
  created_at,
  updated_at
) on public.product_doses to anon, authenticated;

-- Defence in depth, matching the products migration. product_doses_insert_admin,
-- _update_admin and _delete_admin all require current_auth_role() = 'admin',
-- which reads auth.jwt()->>'role' and which no client key can present — so
-- these privileges are unreachable today and RLS is the only line behind them.
revoke insert, update, delete, references on public.product_doses from anon, authenticated;

commit;

-- ============================================================================
-- WITHHELD, and why each is a number the public should never hold:
--
--   product_cost_cents        landed cost of THIS variant -> the real margin
--   min_profit_cents          profit floor, absolute      -> the floor price
--   min_profit_percent        profit floor, relative      -> the floor price
--   min_selling_price_cents   computed floor              -> the floor price
--   suggested_retail_cents    MSRP working figure         -> pricing strategy
--
-- WITHHELD SINCE 2026-08-28 (finding RLS-07):
--
--   inventory_quantity        units on the shelf          -> capital on hand
--   reserved_quantity         units mid-checkout          -> live demand rate
--   incoming_quantity         units inbound               -> restock timing
--   low_stock_threshold       the badge's own trigger     -> infers the count
--
-- VERIFIED against production immediately after applying, with the storefront's
-- own publishable key (sb_publishable_...):
--
--   ?select=label,product_cost_cents   -> 42501 permission denied
--   ?select=*                          -> 42501 permission denied
--   ?select=label,price_cents,stock_status -> 200, rows
--
--   www.vantalabsresearch.com/                     -> 200 (byte-identical)
--   www.vantalabsresearch.com/products             -> 200 (byte-identical)
--   www.vantalabsresearch.com/products/bpc-157     -> 200 (byte-identical)
--   www.vantalabsresearch.com/api/catalog/products -> 200, 36 products,
--                                                     36 with doses, no cost
--                                                     field in any projection
--
-- ROLLBACK, if this ever needs undoing in a hurry:
--
--   grant select on public.product_doses to anon, authenticated;
-- ============================================================================
