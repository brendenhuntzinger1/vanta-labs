-- ============================================================================
-- VANTA LABS — inventory restock exactly-once claim (P2-4).
-- Adds orders.inventory_restocked_at, the atomic claim column that guarantees a
-- refunded/canceled order returns its stock AT MOST ONCE, no matter how many
-- refund events, chargebacks, or admin double-clicks arrive concurrently.
--
-- SAFE + idempotent: `add column if not exists`, nullable, no default backfill,
-- no lock on existing rows, no data change. Existing already-refunded orders
-- keep NULL — harmless (their restock already happened historically; this only
-- governs FUTURE refunds).
--
-- DEPLOY ORDER: run this migration BEFORE deploying the code that calls
-- claimInventoryRestock(). If the column is missing, the claim fails safe
-- (skips restock) rather than double-restocking.
--
-- Rollback: alter table public.orders drop column if exists inventory_restocked_at;
-- ============================================================================

alter table public.orders
  add column if not exists inventory_restocked_at timestamptz;

-- Partial index so the "claim if not yet restocked" update stays cheap.
create index if not exists idx_orders_inventory_restock_pending
  on public.orders(order_id)
  where inventory_restocked_at is null;

select 'inventory_restocked_at' as column_added,
       exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='orders'
           and column_name='inventory_restocked_at'
       ) as present;
