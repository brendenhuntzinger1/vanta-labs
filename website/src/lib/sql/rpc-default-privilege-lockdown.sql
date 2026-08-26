-- ===========================================================================
-- I-11 — disarm the thing that created I-07, instead of sweeping up after it.
--
-- WHAT IS WRONG. Supabase ships a DEFAULT PRIVILEGE that grants EXECUTE on every
-- function created in `public` to `anon` and `authenticated`. Read from
-- production this session (`pg_default_acl`), and it is granted TWICE — once by
-- `postgres` and once by `supabase_admin`:
--
--   schema=public objtype=f
--     {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres,
--      service_role=X/postgres}
--
-- So a new SECURITY DEFINER function is reachable by anyone holding the public
-- anon key **from the moment it is created**. That is not a hypothetical: it is
-- what made `create_partner_invite` an unauthenticated, RLS-bypassing write into
-- the affiliate money tables (I-07).
--
-- Migration `20260825003037_rpc_execute_lockdown` revoked those grants across
-- every function that existed at that moment. It was a SWEEP, not a fix. The
-- default is still armed, so the next function created re-opens the hole, and
-- the sweep would have to be re-run to notice.
--
-- CURRENT STATE, verified: of the 19 SECURITY DEFINER functions in `public`,
-- exactly one is anon-executable — `validate_referral_code`, which the storefront
-- calls to check a referral code and which is deliberately client-callable. Every
-- other one is service_role only. So the sweep held; the door is simply still
-- unlocked for the next arrival.
--
-- WHAT THIS DOES. Removes EXECUTE from the default for `anon` and
-- `authenticated`, so a newly created function starts closed and has to be
-- opened deliberately.
--
-- BLAST RADIUS: none to existing objects. `ALTER DEFAULT PRIVILEGES` changes
-- only what happens at CREATE time; it does not touch a single existing grant.
-- Nothing that works today stops working.
--
-- THIS DOES NOT FULLY CLOSE THE DOOR, AND THAT IS MEASURED, NOT ASSUMED.
--
-- A default privilege can only be altered by the role that granted it, and there
-- are TWO grantors. Proven on the harness project, running as `postgres`:
--
--   BEFORE  grantor=postgres        {postgres=X, anon=X, authenticated=X, service_role=X}
--   BEFORE  grantor=supabase_admin  {postgres=X, anon=X, authenticated=X, service_role=X}
--   AFTER   grantor=postgres        {postgres=X, service_role=X}          <- closed
--   AFTER   grantor=supabase_admin  {postgres=X, anon=X, authenticated=X} <- UNCHANGED
--
-- and a function created after the ALTER was still anon-executable. Half the
-- default is out of reach: `supabase_admin` is Supabase-managed and this
-- project's SQL access is `postgres`.
--
-- So this file is defence in depth, not the control. THE CONTROL IS:
--
--   1. Every migration that creates a function carries its own explicit
--      `revoke ... from public, anon, authenticated` + `grant ... to
--      service_role`. `rpc-security-posture.test.ts` FAILS THE BUILD if one
--      does not, which is the part that does not depend on an author
--      remembering — two remembered and two did not, and the two who did not
--      produced I-07.
--   2. `rpc-exposure-drift-check.sql` is run after any migration that creates a
--      function.
--   3. The `supabase_admin` half is an EXTERNAL DEPENDENCY: it needs Supabase
--      support to change. Recorded as such rather than reported as fixed.
-- ===========================================================================

alter default privileges in schema public
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='anon') then
    execute $q$revoke execute on functions from anon, authenticated;$q$;
  end if;
end
$rpc_lockdown$;


-- Belt and braces for the sweep half: re-close anything that drifted open since
-- 20260825003037, leaving the one deliberately client-callable function alone.
do $$
declare
  fn record;
  client_callable constant text[] := array['validate_referral_code'];
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not (p.proname = any(client_callable))
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    raise notice 'closing %', fn.sig;
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end;
$$;

-- ---- verification: run this AFTER applying -------------------------------
-- Expect `armed = false`. If it is still true, the surviving grantor is
-- supabase_admin (see the limitation above).
--
--   select exists (
--     select 1 from pg_default_acl d
--     join pg_namespace n on n.oid = d.defaclnamespace
--     where n.nspname = 'public' and d.defaclobjtype = 'f'
--       and d.defaclacl::text ~ '(anon|authenticated)=X'
--   ) as armed;
--
-- And the surface itself — expect exactly one row, validate_referral_code:
--
--   select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' and p.prosecdef
--     and (has_function_privilege('anon', p.oid, 'EXECUTE')
--       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
