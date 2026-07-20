-- Annual memberships paid as a one-time manual payment (Cash App / Zelle /
-- PayPal), reusing the existing order + payment-verification flow.
--
-- An annual membership purchase is recorded as an ORDER with
-- order_type='membership', so it flows through the same manual-payment panel,
-- the same admin Payment Verification dashboard, and the same approve action.
-- On approval, the membership is activated (see finalizeManualPayment). Monthly
-- memberships are recurring and go through the card processor instead (with the
-- card processing fee), so they are not orders.
--
-- Run after orders-schema.sql and manual-payments.sql. Idempotent.

alter table if exists public.orders
  -- 'product' (default) or 'membership'. Membership orders are digital: they
  -- are never sent to the 3PL or shown in the fulfillment queue.
  add column if not exists order_type text not null default 'product',
  add column if not exists membership_tier_id uuid,
  add column if not exists membership_cycle text;

create index if not exists idx_orders_order_type on public.orders(order_type);
