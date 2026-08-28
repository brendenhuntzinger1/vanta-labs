-- ============================================================================
-- VANTA LABS — PHASE 11: REVOKE CLIENT-KEY WRITES ACROSS public
--
-- Finding LF-03, widened. LF-03 reported TRUNCATE still granted to anon and
-- authenticated on public.products and public.product_doses. Checking the rest
-- of the schema found the same shape on 64 of the 70 tables in `public`.
--
-- Safe to re-run: revoking a privilege that is not held is a no-op, and the
-- loop below covers tables added since.
--
-- ----------------------------------------------------------------------------
-- WHAT IS ACTUALLY GRANTED
--
-- Measured on production, information_schema.table_privileges, 2026-08-28:
--
--   public tables                                70
--   tables where `anon` holds a write privilege  64
--   tables where `authenticated` does            64
--   tables where `service_role` lacks full write  0
--
-- The 64 include every money and identity table in the system:
-- admin_credentials, admin_sessions, commissions, payouts, partner_payouts,
-- ambassador_wallet_ledger, store_credit_ledger, points_ledger, coupons,
-- commission_tier_rules, membership_tiers, customer_addresses,
-- customer_memberships, inventory_items, inventory_transactions,
-- referral_orders, system_alerts.
--
-- This is the same defect Phase 1 closed on orders/order_items/ambassadors and
-- the two referral/analytics tables, and the same defect the products and
-- product_doses migrations closed for SELECT: a blanket `grant all` sitting
-- under a correct RLS policy. It is the grant that is wrong, not the policy.
--
-- ----------------------------------------------------------------------------
-- HOW MUCH OF IT IS REACHABLE, STATED HONESTLY
--
-- INSERT/UPDATE/DELETE on most of these tables is currently refused by RLS, so
-- PostgREST answers 401 rather than writing. Those grants are latent, not live.
-- They are still wrong: RLS is then the ONLY thing between the publishable key
-- and the row, and one permissive policy — of the kind Phase 1 found three of,
-- each with `with_check (true)` — turns a latent grant into a live write
-- endpoint with nothing behind it.
--
-- TRUNCATE is the exception that is not merely latent. Postgres does not apply
-- row-level security to TRUNCATE at all, so no policy anywhere refuses it and
-- the grant is the whole of the access control. It is NOT reachable today:
-- PostgREST exposes no TRUNCATE verb, and Supabase publishes no direct Postgres
-- connection for `anon`. That should not be overstated into a live hole. It is
-- one SECURITY INVOKER function, or one connection-policy change, away from
-- being a single statement that empties a money table — and there is no reason
-- to carry it.
--
-- ----------------------------------------------------------------------------
-- WHY THIS BREAKS NOTHING
--
-- No client key writes any table in this application. Checked exhaustively:
-- ten files import the browser client from @/lib/supabase, and between them
-- they make exactly thirteen database calls — eleven `supabase.auth.*` (GoTrue
-- sign-in, sign-up, OTP, password reset, updateUser, getSession, signOut), one
-- `supabase.rpc("validate_referral_code")`, and one SELECT on `ambassadors` in
-- lib/referral-client.ts. There is not a single `.insert(`, `.update(`,
-- `.upsert(` or `.delete(` on the browser client anywhere in src/.
--
-- Every write in the system goes through supabaseAdmin (service_role), which
-- bypasses grants and RLS alike, and which retains all seven privileges on all
-- seventy tables — verified, zero gaps.
--
-- The two non-internal triggers in `public` (coa_records_set_updated_at,
-- order_attribution_set_updated_at) are SECURITY DEFINER owned by `postgres`,
-- so they do not run with the caller's privileges and are unaffected. No
-- trigger on the `auth` schema writes into `public`.
--
-- SELECT is deliberately untouched. The storefront serves its catalogue to
-- browsers from `products`, `product_doses`, `membership_tiers` and `coupons`,
-- and the sensitive columns on those tables were already scoped by
-- products-hide-cost-columns-from-public.sql and
-- product-doses-hide-cost-columns-from-public.sql. Revoking reads here would
-- break the storefront and close nothing that is still open.
-- ============================================================================

do $$
declare
  t record;
  n int := 0;
begin
  for t in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on %s from anon, authenticated',
      t.rel
    );
    n := n + 1;
  end loop;

  raise notice 'revoked client-key writes on % tables', n;
end
$$;

-- ============================================================================
-- VERIFICATION — first query must return 0, 0. Second must return 70.
-- ============================================================================
select
  count(*) filter (where grantee = 'anon')          as anon_write_grants_left,
  count(*) filter (where grantee = 'authenticated') as auth_write_grants_left
from information_schema.table_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

select count(*) as tables_service_role_still_writes
from information_schema.table_privileges
where table_schema = 'public'
  and grantee = 'service_role'
  and privilege_type = 'INSERT';

-- The storefront must still READ its catalogue. Must return true, true, true.
select has_table_privilege('anon', 'public.products', 'select')         as products,
       has_table_privilege('anon', 'public.product_doses', 'select')    as doses,
       has_table_privilege('anon', 'public.membership_tiers', 'select') as tiers;

-- ============================================================================
-- ROLLBACK, if this ever needs undoing in a hurry. This restores the blanket
-- grant that was there before, on every table:
--
--   do $$
--   declare t record;
--   begin
--     for t in select c.oid::regclass as rel
--              from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
--              where ns.nspname = 'public' and c.relkind = 'r'
--     loop
--       execute format('grant all on %s to anon, authenticated', t.rel);
--     end loop;
--   end $$;
--
-- A narrower rollback is almost certainly what you actually want: grant back
-- the ONE privilege on the ONE table whose path broke, and write down why the
-- browser needs to write it directly rather than through a route.
-- ============================================================================
