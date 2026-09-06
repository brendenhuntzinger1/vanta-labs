-- Deny-by-default Row Level Security for every public table.
--
-- WHY: NEXT_PUBLIC_SUPABASE_ANON_KEY ships to the browser and Supabase
-- PostgREST is internet-facing, so ANY public table without RLS enabled is
-- world-readable/writable with that key. This application reads and writes all
-- business data through server routes using the service-role key
-- (src/lib/supabase-server.ts), and the service_role Postgres role has the
-- BYPASSRLS attribute — so enabling RLS here NEVER affects the app's own
-- server code. It only slams the door on direct anon/authenticated access.
--
-- Enabling RLS on a table that has no policy makes it deny-by-default: the
-- anon and authenticated roles see zero rows and can write nothing. Tables that
-- already carry user-scoped policies (orders, customer_addresses, partner_*,
-- etc. from their own migrations) keep those policies untouched — this file
-- only guarantees the RLS switch is ON everywhere.
--
-- BEHAVIOR NOTE: the admin control center's live auto-refresh subscribes to
-- `admin_audit_logs` realtime with the anon key. Once RLS is enabled there,
-- that anon subscription receives no rows (which is correct — audit logs must
-- not be anon-readable); the dashboard still loads and can be refreshed
-- normally. No storefront or checkout path depends on anon table reads.
--
-- Idempotent: `enable row level security` is a no-op when already enabled.
-- Run this after all other migrations. Verify afterward with the query at the
-- bottom (Supabase SQL editor) — it must return zero rows.
--
-- ---------------------------------------------------------------------------
-- IT ASKS POSTGRES WHICH TABLES ARE UNCOVERED. IT USED TO CARRY A LIST.
--
-- The list was hand-maintained, and a hand-maintained list of "every table"
-- goes stale the first time somebody adds a table — silently, because a missing
-- name looks exactly like a table that was considered and left out on purpose.
-- ambassador_wallet_ledger is the one that proved it: a real production table
-- carrying user_id, amount_cents, reason, order_id and a free-text note, named
-- in no RLS statement anywhere in this repository. Rebuild the database from
-- the checked-in SQL and it was the only table in `public` with RLS off.
--
-- Production itself was never exposed, because Supabase's own `ensure_rls`
-- event trigger enables RLS on every new table in `public` — that is what makes
-- coverage "every table" rather than "the tables someone remembered", and it is
-- a platform feature this repository does not create and cannot rely on when
-- rebuilding elsewhere. (BASELINE-live-functions-2026-08-25.sql credits a
-- `rls_auto_enable` function for this and points at a `create event trigger`
-- statement below it. There is no such statement in that file, and none in the
-- corpus; the trigger doing the work in production is the platform's.)
--
-- So the sweep now enumerates rather than remembers. A new table is covered the
-- moment this runs, whatever anybody remembered to write down.
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  -- EVERY ordinary and partitioned table in `public` that does not already have
  -- it. Nothing is named here on purpose: a name is something to forget.
  for target in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
    order by c.relname
  loop
    execute format('alter table public.%I enable row level security;', target);
  end loop;
end $$;

-- Named explicitly as well, so this file states the one that was missing rather
-- than only implying it. A no-op after the sweep above, and harmless if the
-- table does not exist in this environment.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'ambassador_wallet_ledger'
  ) then
    execute 'alter table public.ambassador_wallet_ledger enable row level security';
  end if;
end $$;

-- Verification (run manually in the Supabase SQL editor; expect zero rows):
--   select tablename
--   from pg_tables
--   where schemaname = 'public'
--     and rowsecurity = false;
