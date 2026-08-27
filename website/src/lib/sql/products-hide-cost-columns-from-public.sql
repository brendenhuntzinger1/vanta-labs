-- ============================================================================
-- VANTA LABS — STOP THE PUBLIC KEY READING THE STORE'S COST STRUCTURE
-- Paste into: Supabase -> SQL Editor -> New query -> Run. Safe to re-run.
--
-- FINDING A2, 2026-08-27 launch audit. Reproduced against production with the
-- storefront's OWN publishable key, lifted from a page load:
--
--   GET /rest/v1/products?select=*   ->  200, 36 of 36 rows carrying
--                                        product_cost_cents
--
--   igf-1-lr3   retail $119.99   cost $35.00   (70.8% margin)
--   klow        retail $119.99   cost $35.00   (70.8% margin)
--   glow        retail $109.99   cost $35.00   (68.2% margin)
--
-- The complete landed cost and margin of every published product is readable
-- by anyone who opens developer tools. That is not a customer-data breach —
-- there is no PII here — but it is the one number a competitor most wants, and
-- it is served from the company's own API.
--
-- WHAT IS AND IS NOT WRONG. `products_select_public` gets the ROW filter right:
-- it requires is_active AND is_enabled AND is_published AND NOT is_archived,
-- and the audit confirmed zero unpublished and zero archived rows are visible.
-- The problem is purely COLUMN SCOPE. RLS in Postgres cannot express "these
-- rows, but not those columns", so the policy is left exactly as it is and the
-- column list is fixed with GRANTs, which is the mechanism that can say it.
--
-- WHY THIS BREAKS NOTHING. The storefront does not read this table from the
-- browser. The catalogue is served by /api/catalog/products, which runs on the
-- server under the service role, and that route already omits every column
-- below — no shipped feature has ever used them client-side. Verified by
-- grepping every consumer of the browser client (src/lib/supabase.ts): it is
-- used for auth and for the validate_referral_code RPC, and nothing else.
-- service_role and postgres are untouched, so admin, checkout, the profit
-- engine and every server route keep full access.
--
-- ONE BEHAVIOURAL CHANGE WORTH KNOWING. Postgres refuses a `select=*` outright
-- once a role lacks any column, rather than silently trimming it. So after this
-- runs, an anonymous `?select=*` on products returns 42501 instead of rows.
-- That is the correct and louder outcome — but it is why the column list below
-- is spelled out in full rather than being a REVOKE with no matching GRANT:
-- anonymous callers must still be able to ask for the presentation columns by
-- name, which is what the public catalogue is for.
-- ============================================================================

begin;

-- Table-level SELECT outranks any per-column grant, so it has to go first or
-- the GRANT below is decoration. anon = signed-out visitors, authenticated =
-- signed-in customers; neither has any business reading a landed cost.
revoke select on public.products from anon, authenticated;

-- Everything a storefront legitimately renders. Deliberately enumerated: a
-- future column is NOT readable by the public until someone adds it here and
-- says why, which is the correct default for a table that holds cost data.
grant select (
  id,
  slug,
  name,
  category,
  short_description,
  description,
  long_description,
  image_url,
  price_cents,
  compare_at_price_cents,
  sale_price_cents,
  badge,
  position,
  sku,
  -- Stock presentation. Quantities drive "In Stock" / "Low stock" badges and
  -- are already exposed by the public catalogue API.
  stock_status,
  inventory_quantity,
  reserved_quantity,
  incoming_quantity,
  low_stock_threshold,
  track_inventory,
  -- Visibility flags: the RLS policy filters on these, and a reader that
  -- cannot see them cannot express the same predicate.
  is_active,
  is_enabled,
  is_published,
  is_archived,
  is_featured,
  -- Compliance and lab documentation. Public on purpose — the COA library and
  -- every product page are built on it.
  batch_number,
  cas_number,
  coa_url,
  lab_name,
  purity_result,
  testing_date,
  molecular_formula,
  molecular_weight,
  peptide_sequence,
  requires_reconstitution,
  reconstitution_note,
  storage_recommendation,
  shipping_weight_oz,
  product_faq,
  seo_title,
  seo_description,
  created_at,
  updated_at
) on public.products to anon, authenticated;

commit;

-- ============================================================================
-- WITHHELD, and why each one is a number the public should never hold:
--
--   product_cost_cents        landed unit cost           -> the margin itself
--   commission_cost_cents     affiliate cost per unit    -> partner economics
--   shipping_cost_cents       assumed freight per unit   -> completes the COGS
--   min_profit_cents          profit floor, absolute     -> the floor price
--   min_profit_percent        profit floor, relative     -> the floor price
--   min_selling_price_cents   computed floor             -> the floor price
--   suggested_retail_cents    MSRP working figure        -> pricing strategy
--
-- VERIFY (expect: rows for the first, 42501 for the second and third):
--
--   set role anon;
--   select slug, price_cents, stock_status from public.products limit 1;
--   select product_cost_cents from public.products limit 1;   -- must fail
--   select * from public.products limit 1;                    -- must fail
--   reset role;
--
-- ROLLBACK, if this ever needs undoing in a hurry:
--
--   grant select on public.products to anon, authenticated;
-- ============================================================================

-- ============================================================================
-- ADJACENT, AND DELIBERATELY NOT DONE HERE.
--
-- The same audit query showed anon and authenticated also hold INSERT, UPDATE
-- and REFERENCES on this table — all 50 columns. Nothing can currently use
-- them: products_insert_admin and products_update_admin both require
-- current_auth_role() = 'admin', which reads auth.jwt()->>'role', and no client
-- key can present that. So RLS is the only thing standing between the public
-- key and the product catalogue, with no second line behind it.
--
-- That is a defence-in-depth gap rather than a live hole, and it is a wider
-- change than this file was asked for, so it is recorded rather than bundled.
-- The one-line version, once someone has decided they want it:
--
--   revoke insert, update, references on public.products from anon, authenticated;
--
-- VERIFIED 2026-08-27 against the local harness carrying production's real
-- products_select_public policy: anon reads slug/price/stock and gets rows;
-- anon reading product_cost_cents gets 42501; service_role holds its own
-- explicit grant in production and is untouched by the revoke above.
-- ============================================================================
