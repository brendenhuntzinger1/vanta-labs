-- Drift check: what can an ANONYMOUS caller execute in the exposed schema?
--
-- WHY THIS FILE EXISTS
--
-- I-07 was an unauthenticated, RLS-bypassing write into public.partners and
-- public.ambassadors. The interesting part is not that it existed, it is HOW it
-- came back after being closed.
--
-- 20260825003037 `rpc_execute_lockdown` did the right thing: it looped over
-- every SECURITY DEFINER function in `public`, allow-listed exactly one
-- (validate_referral_code), and revoked EXECUTE from public, anon and
-- authenticated. Its own comment explains the trap it was closing:
--
--   "Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon and
--    authenticated on every function created in this schema"
--
-- That sweep is a POINT-IN-TIME fix. The default privilege that caused the
-- problem was left in place, so every function created AFTERWARDS is granted to
-- anon and authenticated again on creation.
--
--   20260825204855  creates a function   no revoke   (validate_referral_code -- intended)
--   20260825214916  creates a function   revoke+grant present
--   20260825215051  creates a function   revoke+grant present
--   20260825231628  creates a function   no revoke   (CREATE OR REPLACE keeps existing ACLs)
--   20260826002258  creates create_partner_invite   NO REVOKE   <-- I-07
--
-- Two authors remembered, two did not, and the one that did not created a
-- brand-new function -- so it took the defaults and was world-executable.
--
-- Run this after ANY migration that creates a function. Anything it returns
-- other than the four known-good rows below is a new exposure.
--
-- EXPECTED OUTPUT (as of 2026-08-26, immediately after I-07 was remediated):
--
--   proname             | sec_definer | anon | authenticated
--   --------------------+-------------+------+--------------
--   current_auth_email  | f           | t    | t
--   current_auth_role   | f           | t    | t
--   current_auth_uid    | f           | t    | t
--   validate_referral_code | t        | t    | t
--
-- The three current_auth_* helpers are SECURITY INVOKER and only read the
-- caller's own JWT claims. validate_referral_code is SECURITY DEFINER and
-- deliberately anonymous: it is STABLE, filtered to status='approved', and the
-- storefront cannot validate a shopper-typed referral code without it.
--
-- A SECURITY DEFINER function appearing here that is not validate_referral_code
-- is a finding until proven otherwise.

select p.proname,
       p.prosecdef                                              as sec_definer,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
order by p.prosecdef desc, p.proname;

-- THE DURABLE FIX -- APPLIED 2026-08-28, AND IT DOES NOT DO WHAT THIS FILE USED
-- TO CLAIM. Corrected after an adversarial review found this file still telling
-- the reader the change was outstanding and still describing the wrong
-- mechanism.
--
-- The one-off revoke in 20260826014217 closes today's hole. It does NOT stop the
-- next one, and that much was right. What was wrong is the remedy:
--
--   alter default privileges in schema public
--     revoke execute on functions from anon, authenticated;
--
-- ran on 2026-08-28 (migrations-applied/20260828T0240_default_privilege_table_
-- write_lockdown.sql:107-108) and changed NOTHING OBSERVABLE. Measured on the
-- harness with three probe functions, one created in a later transaction to
-- rule out visibility: a new function's ACL comes out as
--
--   =X/postgres | postgres=X/postgres | service_role=X/postgres
--
-- There is no `anon=X` entry to remove. anon reaches EXECUTE through **PUBLIC**,
-- which is PostgreSQL's own hard-wired default for functions, not a Supabase
-- default privilege. Revoking the anon/authenticated default entries removes
-- entries that PUBLIC was already covering. `alter default privileges ... revoke
-- execute on functions from public` was tried too and does not suppress it.
--
-- SO THE CONTROL IS NOT A DEFAULT PRIVILEGE AT ALL. It is the per-migration
--
--   revoke all on function public.<name>(<args>) from public, anon, authenticated;
--   grant execute on function public.<name>(<args>) to service_role;
--
-- with `public` in that list being the word that does the work — and
-- rpc-security-posture.test.ts fails the build when a migration omits it. That
-- test has already caught a real omission in this repository.
--
-- The TABLE half of the same default WAS a genuine open hole (every new table
-- arriving with anon=arwdDxtm, which is where the 64-of-70 grant sweep came
-- from) and is closed by that same migration.
--
-- Sibling file rpc-default-privilege-lockdown.sql carries the same correction at
-- its CORRECTION 2026-08-28 block; this file was missed at the time.
