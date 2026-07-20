-- Manual payment methods (Cash App / Zelle / PayPal / future) + the payment
-- verification workflow.
--
-- Adds the columns needed to:
--   1. Offer a short, human-friendly Order Number customers can copy into a
--      payment note (orders.order_number).
--   2. Record which payment method a customer chose and, for card orders, the
--      card processing fee that was added
--      (payment_method, card_processing_fee, card_processing_fee_percent).
--   3. Capture the customer's payment proof - transaction/confirmation id and
--      an optional screenshot uploaded to Supabase Storage
--      (payment_reference, payment_proof_url, payment_submitted_at).
--   4. Track admin verification - who approved/rejected and when, plus a
--      rejection reason the customer can act on
--      (verified_at, verified_by, rejection_reason, payment_rejected_at).
--
-- The manual flow reuses the existing payment_status column with two new
-- values in addition to the existing ones ('pending_payment', 'paid', ...):
--   'awaiting_verification' - customer submitted proof, awaiting admin review
--   'payment_rejected'      - admin rejected; customer may resubmit proof
-- payment_status is a free-text column (no enum/check), so no type change is
-- required.
--
-- Run after orders-schema.sql (and the other orders column migrations).
-- Idempotent - safe to re-run.

alter table if exists public.orders
  add column if not exists order_number text,
  add column if not exists payment_method text,
  add column if not exists card_processing_fee numeric(12,2) not null default 0,
  add column if not exists card_processing_fee_percent numeric(5,2) not null default 0,
  -- Configurable sales tax collected on the order (0 unless an admin sets a rate).
  add column if not exists tax_amount numeric(12,2) not null default 0,
  add column if not exists payment_reference text,
  add column if not exists payment_proof_url text,
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by text,
  add column if not exists rejection_reason text,
  add column if not exists payment_rejected_at timestamptz;

-- Fast lookups by the customer-facing order number (payment verification and
-- the 3PL fulfillment view both search on it) and by payment method (revenue
-- dashboard groups on it).
create unique index if not exists idx_orders_order_number on public.orders(order_number) where order_number is not null;
create index if not exists idx_orders_payment_method on public.orders(payment_method);

-- Supabase Storage bucket for uploaded payment screenshots. Created here for
-- documentation; the app also ensures it exists at runtime
-- (src/lib/payment-proof-storage.ts). PRIVATE — proofs contain PII, so admins
-- view them through short-lived signed URLs, never a public link.
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', false)
on conflict (id) do nothing;
