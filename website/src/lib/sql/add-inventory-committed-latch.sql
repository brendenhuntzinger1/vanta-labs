-- ============================================================================
-- VANTA LABS — the inventory RECEIPT, separate from the paid-side-effects CLAIM
-- (VL-10 / INV-01 / F1).
--
-- Adds orders.inventory_committed_at: written by BOTH paid lanes
-- (processPaymentWebhook and finalizeManualPayment) only AFTER the order's stock
-- has actually moved, and read by returnInventoryForCancelledOrder to decide
-- whether a cancel returns units or merely releases a hold.
--
-- WHY A SECOND COLUMN. The cancel path used to read `paid_side_effects_at`. In
-- the card lane that column is the exactly-once CLAIM over every paid side
-- effect, so it is stamped BEFORE they run — it has to be, or a duplicate
-- webhook delivery pays the ambassador twice. It therefore means "this delivery
-- won the right to try", not "the units left the shelf", and it is stamped
-- whether the decrement then succeeds, fails, or moves only some lines.
-- Cancelling an order whose decrement had failed therefore restocked units that
-- were never removed: invented stock, which oversells.
--
-- BACKFILL. Existing paid orders are stamped from `paid_side_effects_at`, which
-- for those rows is the best evidence available that their decrement ran (and,
-- for the manual lane, is exactly that fact — it withholds the latch on a failed
-- decrement). Without the backfill every already-paid order would look
-- "never decremented" to a cancel and have its stock written off, which is the
-- K-17 loss this whole return path exists to stop.
--
-- SAFE + idempotent: `add column if not exists`, nullable, no default, and the
-- backfill only touches rows where the new column is still NULL.
--
-- APPLIED TO PRODUCTION 2026-08-28 as migration 20260828001215; the applied copy
-- is recorded in sql/migrations-applied/ alongside its verification.
--
-- DEPLOY ORDER: run this migration BEFORE deploying the code. Without the
-- column, the paid lanes' latch write fails (logged, never fatal — the payment
-- still completes) and the cancel path's select errors, which is its
-- "do not guess" branch: it raises cancellation_inventory_unresolved for a human
-- rather than restocking or releasing blind.
--
-- Rollback: alter table public.orders drop column if exists inventory_committed_at;
-- ============================================================================

alter table public.orders
  add column if not exists inventory_committed_at timestamptz;

-- Historical paid orders: the decrement ran under the old single latch.
update public.orders
   set inventory_committed_at = paid_side_effects_at
 where inventory_committed_at is null
   and paid_side_effects_at is not null;

select 'inventory_committed_at' as column_added,
       exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='orders'
           and column_name='inventory_committed_at'
       ) as present,
       (select count(*) from public.orders where inventory_committed_at is not null) as backfilled_rows;
