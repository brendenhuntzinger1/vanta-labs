-- ============================================================================
-- RPC lockdown: stop anon/authenticated executing our SECURITY DEFINER functions.
--
-- WHY THE EXISTING HARDENING DID NOT HOLD
--
-- admin-dashboard-rollups.sql, admin-partner-rollups.sql and
-- inventory-enforce-positive-stock.sql already do the right thing:
--
--     revoke all on function public.admin_customer_rollup(text,int,int) from public;
--     grant  execute on function public.admin_customer_rollup(text,int,int) to service_role;
--
-- That revokes the PUBLIC pseudo-role. It is not enough. Supabase ships this
-- project with:
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- so every function CREATED in public is handed an EXPLICIT execute grant to
-- anon and authenticated at creation time. Revoking PUBLIC never touches an
-- explicit role grant, so the grant survived and the lockdown silently did
-- nothing. Confirmed on production: pg_proc.proacl for admin_customer_rollup
-- reads `anon=X/postgres | authenticated=X/postgres`, and calling it after
-- `set role anon` returns customer email, name and lifetime spend.
--
-- WHY IT MATTERS
--
-- SECURITY DEFINER functions run as the owner and bypass RLS entirely. There is
-- no policy layer for a function — EXECUTE is the only gate. PostgREST exposes
-- every public function at /rest/v1/rpc/<name>, and the anon key is public by
-- design (it ships in the browser bundle). So anon EXECUTE on these means:
--
--   admin_customer_rollup   every customer's email, name, order count, spend
--   admin_revenue_summary   total revenue, order counts, processing fees
--   admin_ops_summary       operational and financial rollups
--   admin_partner_rollups   partner/ambassador financials
--   redeem_coupon           burn any active coupon's redemption budget
--   release_inventory_for_order   drop an order's stock hold (oversell)
--   finalize_inventory_for_order  decrement real stock for an order id
--
-- Every one of these is called ONLY through supabaseAdmin (service_role) in
-- application code, so removing anon/authenticated costs nothing at runtime.
-- The single deliberate exception is validate_referral_code, which
-- src/lib/referral-client.ts calls from the browser with the anon key to
-- preview a referral discount. It stays granted, on purpose.
--
-- Idempotent. Safe to re-run, and worth re-running after adding any function to
-- the public schema, because the default privilege above will have granted the
-- new one to anon as well.
-- ============================================================================

do $$
declare
  fn record;
  -- Functions the browser is MEANT to call with the anon key. Anything not
  -- listed here is server-only and gets locked down.
  client_callable constant text[] := array['validate_referral_code'];
begin
  for fn in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not (p.proname = any(client_callable))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
    raise notice 'locked down %', fn.sig;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- VERIFICATION. Read-only. Expect exactly one row: validate_referral_code.
-- Any other row is a SECURITY DEFINER function an anonymous browser can still
-- call, and is a finding.
-- ---------------------------------------------------------------------------
select
  p.proname                                             as still_anon_executable,
  has_function_privilege('anon', p.oid, 'EXECUTE')      as anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and (
    has_function_privilege('anon', p.oid, 'EXECUTE')
    or has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
order by p.proname;
