-- ============================================================================
-- VANTA LABS — MIGRATION 2026-07-23
-- Everything the audit/feature work of 2026-07-23 added to the schema, bundled
-- into ONE idempotent script. Paste into Supabase -> SQL Editor -> New query ->
-- Run. Expect "Success. No rows returned."
--
-- Safe on a fresh OR existing database, and safe to re-run (every statement is
-- `add column if not exists` / `create table if not exists` / a no-op alter).
-- It never drops or overwrites data. All of this is also already included in
-- deploy-run-once.sql, so if you run that fresh you do NOT also need this.
--
-- What it adds:
--   1. Premium product spec fields (molecular weight, CAS #, sequence, storage,
--      reconstitution, per-product FAQ).
--   2. Durable rate-limit store (serverless-safe abuse throttling).
--   3. Webhook event crash recovery (claimed_at + nullable processed_at).
--   4. Ambassador payout method (PayPal / Venmo / Cash App + handle).
--   5. Exactly-once paid side-effects gate (prevents duplicate payout / stock /
--      email and reverts on a duplicate paid delivery).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Premium product spec fields
-- ---------------------------------------------------------------------------
alter table if exists public.products
  add column if not exists molecular_weight text,
  add column if not exists cas_number text,
  add column if not exists peptide_sequence text,
  add column if not exists storage_recommendation text,
  add column if not exists reconstitution_note text,
  add column if not exists product_faq jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. Durable rate-limit store (RLS deny-by-default; service role only)
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_hits_bucket_time_idx
  on public.rate_limit_hits (bucket, created_at desc);
alter table if exists public.rate_limit_hits enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Webhook event crash recovery
--    processed_at now means "finished" (NULL = claimed but not yet done);
--    claimed_at records when the claim was taken so a stale claim can be retaken.
-- ---------------------------------------------------------------------------
alter table if exists public.payment_events
  add column if not exists claimed_at timestamptz not null default now();
alter table if exists public.payment_events
  alter column processed_at drop not null;

-- ---------------------------------------------------------------------------
-- 4. Ambassador payout method (how the business pays the ambassador)
-- ---------------------------------------------------------------------------
alter table if exists public.partners
  add column if not exists payout_method text,
  add column if not exists payout_handle text,
  add column if not exists payout_updated_at timestamptz;
alter table if exists public.ambassadors
  add column if not exists payout_method text,
  add column if not exists payout_handle text,
  add column if not exists payout_updated_at timestamptz;
alter table if exists public.partner_payouts
  add column if not exists payout_method text,
  add column if not exists payout_handle text;
alter table if exists public.payouts
  add column if not exists payout_method text,
  add column if not exists payout_handle text;

-- ---------------------------------------------------------------------------
-- 5. Exactly-once paid side-effects gate
--    NULL = the one-time paid side-effects (commission, coupon, points, email,
--    inventory, 3PL) have not run yet. One webhook delivery claims it; duplicates
--    lose the claim and skip, so nobody is paid/charged/decremented twice.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists paid_side_effects_at timestamptz;

-- ---------------------------------------------------------------------------
-- Verify (optional). Both queries should return the expected rows:
--   RLS on every table (should return ZERO rows):
--     select tablename from pg_tables
--     where schemaname='public' and rowsecurity=false;
--   New columns present:
--     select column_name from information_schema.columns
--     where table_name='orders' and column_name='paid_side_effects_at';
-- ---------------------------------------------------------------------------
