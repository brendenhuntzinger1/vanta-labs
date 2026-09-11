-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- ORDER ITEMS, INDEXED BY ORDER, 2026-09-10.
--
-- `order_items.order_id` is a foreign key to `orders` and the column every
-- order read joins on, and it had no index: `order_items_pkey` on `id` was the
-- only one on the table. Supabase's performance advisor flags exactly this
-- (unindexed_foreign_keys), and it was confirmed against production on
-- 2026-09-10 while investigating the cron gateway timeouts.
--
-- Harmless at forty orders. Every read of an order's lines becomes a sequential
-- scan of the whole table once there are thousands, and the ON DELETE CASCADE
-- on the constraint means deleting an order scans it too. Building it now
-- costs a few milliseconds; building it later costs a slow query first.
--
-- CONCURRENTLY, so the table is never locked against checkout while it builds.
-- That keyword cannot run inside a transaction, which is why this file is one
-- statement and not wrapped in begin/commit like its neighbours.

create index concurrently if not exists order_items_order_id_idx
  on public.order_items (order_id);
