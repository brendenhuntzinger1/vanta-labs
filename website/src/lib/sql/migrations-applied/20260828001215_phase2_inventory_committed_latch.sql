-- ============================================================================
-- VANTA LABS — PHASE 2 OF THE FINAL-AUDIT REMEDIATION
-- orders.inventory_committed_at: the inventory RECEIPT, separate from the
-- paid-side-effects CLAIM.
--
-- Findings closed (with the code in the same commit): VL-10 / INV-01 / F1.
--
-- Recorded here under the same version applied to production (20260828001215)
-- so the database and the repository carry the same history — the drift pattern
-- F-009 names. Safe to re-run: both statements are idempotent.
--
-- APPLIED TO PRODUCTION 2026-08-28. Verified immediately after:
--   column present, 7 receipts, 7 paid claims, 0 rows where the two disagree
--   (19 orders total).
--
-- ----------------------------------------------------------------------------
-- WHAT WAS ACTUALLY WRONG
--
-- returnInventoryForCancelledOrder decided "were this order's units
-- decremented?" by reading orders.paid_side_effects_at. In the CARD lane that
-- column is the exactly-once CLAIM over every paid side effect, so it is stamped
-- BEFORE they run — it has to be, or a duplicate webhook delivery pays the
-- ambassador twice. It means "this delivery won the right to try", not "the
-- units left the shelf", and it is written whether the decrement that follows
-- then succeeds, fails, or moves only some lines.
--
-- Read as proof of the decrement, cancelling an order whose decrement had FAILED
-- took the restock branch and returned units that were never removed: invented
-- stock, which oversells. That is the exact direction this codebase's inventory
-- rule forbids — under-restock is a recoverable inconvenience, over-restock is a
-- money-losing oversell.
--
-- The MANUAL lane had already reasoned its way to the right answer and simply
-- withholds its latch when the decrement does not complete. The card lane cannot
-- copy that without giving up its claim. So the claim and the receipt become two
-- columns: this one is written by both paid lanes only AFTER stock has moved,
-- and it is what the cancel path reads.
--
-- ----------------------------------------------------------------------------
-- WHY THE BACKFILL
--
-- Existing paid orders are stamped from paid_side_effects_at, which for those
-- rows is the best evidence available that their decrement ran (and, for the
-- manual lane, is exactly that fact). Without it every already-paid order would
-- look "never decremented" to a cancel and have its stock written off — the
-- K-17 loss the whole return path exists to stop.
--
-- Rollback: src/lib/sql/ROLLBACK-inventory-committed-latch.sql
-- ============================================================================

alter table public.orders
  add column if not exists inventory_committed_at timestamptz;

-- Historical paid orders: the decrement ran under the old single latch.
update public.orders
   set inventory_committed_at = paid_side_effects_at
 where inventory_committed_at is null
   and paid_side_effects_at is not null;
