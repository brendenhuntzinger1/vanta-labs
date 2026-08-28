-- ============================================================================
-- VL-SQL-04 (widened) — DISARM THE DEFAULT THAT CREATED THE 64-TABLE SWEEP.
--
-- APPLIED TO PRODUCTION 2026-08-28 under the owner's standing SQL
-- authorisation. Recorded here so the database and the repository carry the
-- same history.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG, AND WHY IT IS THE ROOT CAUSE RATHER THAN ANOTHER INSTANCE.
--
-- Supabase ships a DEFAULT PRIVILEGE granting anon and authenticated full table
-- rights on every table created in `public`. Read from production before this
-- ran:
--
--   for_role=postgres  objtype=r
--     postgres=arwdDxtm | anon=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
--
-- `arwdDxtm` is INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN. So a table created in `public` was fully writable by anyone holding
-- the publishable key FROM THE MOMENT IT WAS CREATED.
--
-- That is not a hypothesis about a future table. It is the explanation for
-- 20260828001500_revoke_client_key_writes_all_tables.sql, which found 64 of 70
-- production tables carrying anon write grants. Nobody granted those. They were
-- INHERITED, one table at a time, from this default. That migration was a
-- SWEEP; this is the fix. Without it, table 71 arrives open and the sweep has
-- to be re-run to notice.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
--
-- Revokes exactly the six privileges that sweep revoked from all 70 existing
-- tables — insert, update, delete, truncate, references, trigger — so the
-- DEFAULT now matches the state actually enforced on the tables. SELECT is
-- deliberately preserved: the sweep preserved it too (that file, :72), the
-- catalogue tables are read with the publishable key, and a default that
-- removed SELECT would break the next catalogue table in a way RLS could not
-- explain.
--
-- ----------------------------------------------------------------------------
-- BLAST RADIUS: NONE TO ANYTHING THAT EXISTS. Measured, not assumed.
--
-- ALTER DEFAULT PRIVILEGES changes only what happens at CREATE time. Proven on
-- the separate vanta-audit-harness project (same Postgres 17, same Supabase
-- defaults) rather than argued from the manual:
--
--   table created BEFORE the alter:  anon INSERT t  DELETE t  TRUNCATE t  SELECT t
--   table created AFTER  the alter:  anon INSERT f  DELETE f  TRUNCATE f  SELECT t
--   the BEFORE table, re-checked after the alter:
--                                    anon INSERT t  DELETE t  TRUNCATE t  SELECT t
--                                    ^ untouched, which is the whole claim
--
-- Verified on production immediately after applying — 70 tables:
--
--   anon SELECT   63      (unchanged, deliberate)
--   anon INSERT    0
--   anon UPDATE    0
--   anon DELETE    0
--   anon TRUNCATE  0
--
--   www.vantalabsresearch.com/                     -> 200
--   www.vantalabsresearch.com/products             -> 200
--   www.vantalabsresearch.com/products/bpc-157     -> 200
--   www.vantalabsresearch.com/api/catalog/products -> 200, products served
--
-- ----------------------------------------------------------------------------
-- THE FUNCTION HALF IS INCLUDED AND DOES NOT WORK. Stated plainly because
-- rpc-default-privilege-lockdown.sql gives the wrong reason for that, and the
-- wrong reason sends the next person to Supabase support instead of to the fix.
--
-- Those two statements succeed, and the postgres/f default becomes
-- `postgres=X | service_role=X`. A function created afterwards is STILL
-- anon-executable. Three probes on the harness, one created in a later
-- transaction to rule out visibility, all came back the same, and the object
-- ACL says why:
--
--   vl_defacl_probe3 proacl = "=X/postgres | postgres=X/postgres | service_role=X/postgres"
--                              ^^ the leading "=X" is PUBLIC, not anon
--
-- There is no `anon=X` entry. anon reaches EXECUTE through PUBLIC, which is
-- PostgreSQL's own hard-wired default for functions — not, as that file states,
-- through a supabase_admin-granted default that "needs Supabase support to
-- change". `alter default privileges ... revoke execute on functions from
-- public` does not suppress it either; that was tested too.
--
-- So the control is what it always was, and it is already in place: every
-- migration that creates a function carries its own
-- `revoke all on function ... from public, anon, authenticated`, and
-- rpc-security-posture.test.ts fails the build when one does not. That test
-- caught a missing revoke in this very session. The statements are kept here
-- because they are correct and harmless, and because removing an anon grant
-- that PUBLIC currently masks is still worth having if PUBLIC is ever closed.
--
-- ----------------------------------------------------------------------------
-- NOT REACHABLE FROM THIS ROLE: the supabase_admin-owned defaults. A default
-- privilege can only be altered by the role it belongs to, and
-- `select current_user, rolsuper, pg_has_role(current_user,'supabase_admin','MEMBER')`
-- returns postgres / false / false. Those apply only to objects created BY
-- supabase_admin, which this project's migrations never are.
-- ============================================================================

alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from authenticated;

alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- Verification. postgres/r must show anon and authenticated reduced to `rm`
-- (SELECT + MAINTAIN) with every write letter gone.
select pg_get_userbyid(defaclrole) as for_role,
       defaclobjtype::text          as objtype,
       coalesce(array_to_string(defaclacl, ' | '), '(EMPTY)') as acl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace
order by 1, 2;

-- ============================================================================
-- ROLLBACK, if a future table genuinely needs the old behaviour (it should get
-- an explicit grant instead):
--
--   alter default privileges in schema public
--     grant insert, update, delete, truncate, references, trigger
--     on tables to anon, authenticated;
-- ============================================================================
