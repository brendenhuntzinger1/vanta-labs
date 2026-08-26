-- I-07 — remove anonymous EXECUTE on public.create_partner_invite.
--
-- APPLIED TO PRODUCTION 2026-08-26, on the owner's explicit approval.
-- Recorded in supabase_migrations.schema_migrations as
--   version 20260826014217, name `revoke_anon_create_partner_invite`
-- and committed here under the same version so the database and the repository
-- carry the same history. See F-009 in the ledger: the drift is not that the
-- migration mechanism is missing, it is that applied SQL was never committed.
--
-- WHY
--
-- create_partner_invite is SECURITY DEFINER, owned by `postgres`, and carries
-- EXECUTE for both `anon` and `authenticated`. SECURITY DEFINER means it runs
-- with the owner's rights and bypasses RLS on `partners` and `ambassadors`.
-- The function body performs NO authorization check of any kind -- it never
-- looks at auth.uid(), auth.jwt(), or any caller identity.
--
-- PostgREST exposes every function in the `public` schema at
-- /rest/v1/rpc/<name>, and NEXT_PUBLIC_SUPABASE_ANON_KEY ships to every
-- browser. So anyone on the internet can call it and write directly into the
-- two affiliate money tables.
--
-- WHY THIS IS SAFE TO REVOKE
--
-- The application never calls it. `create_partner_invite` appears nowhere in
-- this repository -- not in src/, not in any migration, not in docs. The
-- application's partner-creation RPC is `create_partner_application`, which is
-- a different function. This one is orphaned live-database drift, so revoking
-- it cannot break any code path that exists.
--
-- Server-side callers are unaffected regardless: the service-role key bypasses
-- these grants entirely.
--
-- VERIFY BEFORE RUNNING that nothing has started using it since:
--
--   select proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'create_partner_invite';

revoke execute on function public.create_partner_invite(
  uuid, uuid, text, text, text, numeric, uuid
) from anon, authenticated, public;

-- Verification — must return anon_exec = false, auth_exec = false.
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_partner_invite';

-- DELIBERATELY NOT TOUCHED: public.validate_referral_code is also anon-EXECUTE
-- SECURITY DEFINER, and that is correct. It is STABLE (read-only), restricted
-- to `status = 'approved'`, and returns only what the storefront needs to apply
-- a referral discount for a code a shopper has typed in. Referral codes are
-- meant to be shared publicly; the storefront cannot validate one without it.
