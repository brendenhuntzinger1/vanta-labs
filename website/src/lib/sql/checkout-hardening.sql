-- ============================================================================
-- VANTA LABS — CHECKOUT HARDENING
-- Idempotency key on orders so a lost checkout response + user/network retry
-- can never create a second order (each order carries its own inventory hold).
-- The app degrades gracefully if this hasn't been run (idempotency simply
-- no-ops), so it is safe to apply any time before launch.
-- Safe to re-run. Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================

alter table public.orders
  add column if not exists idempotency_key text;

-- One live order per key. Partial unique index so the many NULL keys (older
-- orders, or requests that didn't send one) never collide with each other.
create unique index if not exists orders_idempotency_key_uniq
  on public.orders (idempotency_key)
  where idempotency_key is not null;

-- Billing address, captured at checkout (used by the card processor for AVS
-- once it's connected). Previously the checkout form collected and validated
-- this then dropped it; now it's persisted so it's ready for the processor.
alter table public.orders
  add column if not exists billing_full_name text,
  add column if not exists billing_address text,
  add column if not exists billing_city text,
  add column if not exists billing_postal_code text;

-- Hot-path lookup indexes the app actually queries by.
create index if not exists orders_customer_email_idx on public.orders (customer_email);
create index if not exists orders_payment_id_idx on public.orders (payment_id);
