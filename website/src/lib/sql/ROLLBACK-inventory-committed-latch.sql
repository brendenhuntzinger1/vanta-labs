-- ============================================================================
-- ROLLBACK for add-inventory-committed-latch.sql.
--
-- Dropping the column reverts the cancel path to erroring on its select, which
-- is its "do not guess" branch: cancellation_inventory_unresolved for a human,
-- never a blind restock. Deploy the previous code alongside this.
--
-- Check what you are dropping first:
--   select count(*) from public.orders where inventory_committed_at is not null;
-- ============================================================================

alter table public.orders
  drop column if exists inventory_committed_at;
