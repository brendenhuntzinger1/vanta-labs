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
