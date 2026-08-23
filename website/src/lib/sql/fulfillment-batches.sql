-- ============================================================================
-- VANTA LABS — FULFILLMENT BATCHES (PHASE B)
--
-- One idea, deliberately small: a BATCH is the set of orders an operator
-- decided to work on together this morning. Nothing else.
--
-- WHAT A BATCH IS NOT, and this is the whole design constraint:
--
--   * NOT a payment state          — payment_status stays authoritative
--   * NOT an inventory state       — reserve/finalize/release are untouched
--   * NOT a fulfillment state      — order-pipeline.ts remains the only
--                                    authority over fulfillment_status
--   * NOT a shipping state         — Shippo and the carrier own that
--
-- Adding an order to a batch changes NOTHING about the order. Removing it
-- changes nothing either. If every row in both tables were deleted, no order
-- would be wrong — only the grouping would be lost. That is the test a purely
-- operational entity has to pass, and it is why there is no batch_id column on
-- `orders`: a foreign key there would invite code to read batch membership as
-- if it meant something about the order's real state.
--
-- Additive and idempotent: two new tables, nothing existing is altered,
-- retyped, backfilled or constrained. Safe to re-run.
--
-- DEPLOY ORDER: run this BEFORE the code that reads it. Deployed the other way
-- round, the batch screens query tables that do not exist and the whole
-- fulfillment tab errors — the queues are read-only over `orders`, so they
-- would otherwise have worked fine.
--
-- ROLLBACK: `drop table if exists public.fulfillment_batch_orders;` then
-- `drop table if exists public.fulfillment_batches;`. Nothing references them,
-- no order row is touched, and the admin falls back to the ungrouped queues.
--
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The batch itself
-- ---------------------------------------------------------------------------
create table if not exists public.fulfillment_batches (
  id          uuid primary key default gen_random_uuid(),
  -- Human label an operator can say out loud: "2026-08-22-AM".
  label       text not null,
  -- open   — being picked/packed
  -- closed — the operator finished with it
  status      text not null default 'open',
  created_by  text,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  updated_at  timestamptz not null default now()
);

comment on table public.fulfillment_batches is
  'Operational grouping of orders for a picking/packing session. Never a source of truth for payment, inventory, fulfillment or shipping state.';

-- Only ONE batch may be open at a time in practice, but that is a workflow
-- preference rather than an invariant — a second bench would want a second
-- open batch — so it is not constrained here.
create index if not exists idx_fulfillment_batches_status
  on public.fulfillment_batches (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Membership
--
-- `removed_at` rather than DELETE: taking an order out of a batch is a real
-- operational event ("this one turned out to be an exception"), and deleting
-- the row would erase the fact that it was ever picked up.
-- ---------------------------------------------------------------------------
create table if not exists public.fulfillment_batch_orders (
  id         uuid primary key default gen_random_uuid(),
  batch_id   uuid not null references public.fulfillment_batches(id) on delete cascade,
  -- Matches the FK style used by order_items / order_shipments.
  order_id   text not null references public.orders(order_id) on delete cascade,
  added_at   timestamptz not null default now(),
  removed_at timestamptz
);

comment on table public.fulfillment_batch_orders is
  'Which orders are in which batch. removed_at preserves the history of an order that was pulled out.';

-- THE ONE REAL SAFETY PROPERTY IN THIS MIGRATION.
--
-- An order may sit in at most one ACTIVE batch. Without this, two operators
-- could each pull the same order into their own batch and both would pick,
-- pack and label it — one parcel's contents leaving twice. The partial index
-- allows any number of historical (removed) memberships while permitting
-- exactly one live one.
create unique index if not exists idx_fulfillment_batch_orders_one_active
  on public.fulfillment_batch_orders (order_id)
  where removed_at is null;

create index if not exists idx_fulfillment_batch_orders_batch
  on public.fulfillment_batch_orders (batch_id)
  where removed_at is null;

-- ---------------------------------------------------------------------------
-- 3. RLS
--
-- Both tables are admin-only and are read exclusively through the service role
-- (supabaseAdmin), which bypasses RLS. Enabling it with NO policy is therefore
-- the correct posture: the anon and authenticated roles get nothing, matching
-- admin_audit_logs and the other operator tables.
-- ---------------------------------------------------------------------------
alter table public.fulfillment_batches enable row level security;
alter table public.fulfillment_batch_orders enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the operational queues
--
-- Derived from the actual Phase B queries and their plans, measured on a
-- 50,555-row clone of `orders`:
--
--   bucket list, single-status equality   10.78 ms -> 0.075 ms
--     (seq scan + sort  ->  ordered index scan reading exactly 25 rows)
--   bucket counts, all buckets            17.93 ms -> 7.08 ms
--     (seq scan  ->  index-only scan)
--
-- COLUMN ORDER IS THE WHOLE POINT of the first index. Equality columns first,
-- then the sort key: with paid_at third, Postgres walks the index already in
-- order and stops at the page size instead of reading every matching row and
-- sorting it. A bare index on (fulfillment_status) produces a bitmap scan that
-- discards the ordering — measured at 4.04 ms, ~50x slower than this one.
--
-- CONCURRENTLY: no ACCESS EXCLUSIVE lock, so reads and writes continue during
-- the build. It cannot run inside a transaction block, which is why these two
-- statements are at the end of the file and must not be wrapped in BEGIN/COMMIT.
-- A failed build leaves an INVALID index that is dropped and retried; nothing
-- is corrupted.
--
-- WRITE COST: two more indexes on a table that already has 30. Roughly 1.5-2 MB
-- per 50k orders, and a small cost on insert and on each status transition.
-- Orders are written once and transition a handful of times while these queries
-- run on every admin page load, so the trade is clear.
--
-- ROLLBACK: drop index concurrently if exists <name>;  Plans return to today's.
-- ---------------------------------------------------------------------------
create index concurrently if not exists idx_orders_fulfillment_queue
  on public.orders (payment_status, fulfillment_status, paid_at);

create index concurrently if not exists idx_orders_fulfillment_counts
  on public.orders (fulfillment_status)
  where payment_status = 'paid' and order_type is distinct from 'membership';
