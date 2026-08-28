-- Exact rollback for inventory-return-path.sql.
--
-- Dropping these returns the store to a state where no refund or cancellation
-- ever returns stock, and where the paid-path FALLBACK decrement is inert.
-- The paid path itself is unaffected either way: it moves stock through
-- finalize_inventory_for_order, which this migration does not touch.
--
-- Check what would be lost first — orders whose stock HAS been returned:
--   select count(*) from public.orders where inventory_restocked_at is not null;
--
-- If that is non-zero, dropping the column loses the record that those units
-- were already returned, and a later re-run of this migration would let them be
-- returned a SECOND time. Prefer leaving the column in place and reverting only
-- the function if that is the intent.

-- NOT SYMMETRIC OUTSIDE PRODUCTION. adjust_inventory_on_sale is ALSO created by
-- the base schema (deploy-run-once.sql:981), so in any database built from it --
-- staging, a rebuild, the browser harness -- this drop removes a function that
-- predates inventory-return-path.sql, and the paid-path fallback then errors
-- 42883 instead of degrading. Production is the exception this file was written
-- against: the function was ABSENT there (inventory-return-path.sql:7).
-- Outside production, re-run deploy-run-once.sql (or just its
-- adjust_inventory_on_sale block) afterwards to restore the base version.
drop function if exists public.adjust_inventory_on_sale(text, text, integer);

drop index if exists public.orders_inventory_restock_pending_idx;

alter table public.orders
  drop column if exists inventory_restocked_at;
