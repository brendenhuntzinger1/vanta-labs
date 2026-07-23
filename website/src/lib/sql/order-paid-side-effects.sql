-- ============================================================================
-- VANTA LABS — EXACTLY-ONCE PAID SIDE-EFFECTS
-- A single atomic gate for the one-time side-effects that run when an order is
-- paid (commission, coupon redeem, loyalty points, confirmation email,
-- inventory decrement, 3PL transmit, analytics). Set the moment one webhook
-- delivery claims the side-effects; a concurrent/duplicate/replayed delivery
-- loses the claim and skips them — so an ambassador can't be paid twice and a
-- shipped order can't revert. NULL means the side-effects have not run yet, so
-- a crash BETWEEN the paid-flip and the side-effects is recovered on retry.
-- Idempotent + safe to re-run.
-- ============================================================================

alter table if exists public.orders
  add column if not exists paid_side_effects_at timestamptz;
