-- ============================================================================
-- VANTA LABS — STOP THE PUBLIC KEY READING THE SHELF DEPTH
--
-- Finding RLS-07. NOT APPLIED YET — unlike its neighbours in this directory,
-- this one still has to be pasted into Supabase -> SQL Editor -> New query ->
-- Run. Safe to re-run: revoking a privilege that is not held is a no-op.
--
-- WHAT IS WRONG. products-hide-cost-columns-from-public.sql revoked table-level
-- SELECT and re-granted a named column list. That list included the raw stock
-- quantities, on the stated ground that they are "already exposed by the public
-- catalogue API". They are not. src/lib/catalog.ts says the opposite, in as
-- many words:
--
--   // inventoryQuantity is deliberately ABSENT. These objects are handed to
--   // client components, so anything on them is readable in the page source;
--   // the shelf depth is the owner's information.
--
-- What the catalogue publishes is an AVAILABILITY figure, and it is clamped:
-- publishableAvailability() returns min(available, MAX_UNITS_PER_ORDER_LINE),
-- so a reader of the page source learns at most "ten or more". The PostgREST
-- grant handed that same anonymous key the uncapped count, plus
-- reserved_quantity (how fast the line is moving right now) and
-- incoming_quantity (when the restock lands) — neither of which the application
-- publishes in any form. The application capped the disclosure; the grant
-- undid the cap.
--
-- WHAT IS KEPT, AND WHY. stock_status is the derived badge the storefront is
-- built on, and track_inventory is a boolean that discloses no depth, so both
-- stay granted. batch_number, lab_name and testing_date stay too — the product
-- page renders them from the same server route, so they are public by design.
--
-- WHY THIS BREAKS NOTHING. No browser code reads either table. Ten files import
-- the browser client from @/lib/supabase, and the only table read between them
-- is `ambassadors` in lib/referral-client.ts — src/lib/client-key-table-access.test.ts
-- is the standing guard on that. Every catalogue read runs server-side under
-- service_role, which bypasses grants and RLS alike.
--
-- THE ONE THING TO WATCH. app/admin/products/page.tsx subscribes to
-- postgres_changes on `products` and `product_doses` from the browser client,
-- and Realtime evaluates the subscriber's own access. The supabase_realtime
-- publication contains no tables in this project (verified 2026-08-27 when
-- product-doses-hide-cost-columns-from-public.sql was applied), so that
-- subscription delivers nothing either way today. If the publication is ever
-- switched on, confirm the admin list still auto-refreshes — the blast radius
-- is contained either way, because the handler only calls loadProducts(),
-- which is a server route running under service_role.
-- ============================================================================

begin;

revoke select (inventory_quantity, reserved_quantity, incoming_quantity, low_stock_threshold)
  on public.products from anon, authenticated;

revoke select (inventory_quantity, reserved_quantity, incoming_quantity, low_stock_threshold)
  on public.product_doses from anon, authenticated;

commit;

-- ============================================================================
-- VERIFY (expect: rows for the first, 42501 for the second and third):
--
--   set role anon;
--   select slug, price_cents, stock_status from public.products limit 1;
--   select inventory_quantity from public.products limit 1;      -- must fail
--   select reserved_quantity from public.product_doses limit 1;  -- must fail
--   reset role;
--
-- And the storefront must be unchanged: /api/catalog/products still returns
-- every product with its doses and its clamped availability figure, because
-- that route runs under service_role.
--
-- ROLLBACK, if this ever needs undoing in a hurry:
--
--   grant select (inventory_quantity, reserved_quantity, incoming_quantity, low_stock_threshold)
--     on public.products to anon, authenticated;
--   grant select (inventory_quantity, reserved_quantity, incoming_quantity, low_stock_threshold)
--     on public.product_doses to anon, authenticated;
--
-- The two source migrations were edited in the same change to drop these four
-- names from their grant lists, so re-running either of them no longer restores
-- what this revokes.
-- ============================================================================
