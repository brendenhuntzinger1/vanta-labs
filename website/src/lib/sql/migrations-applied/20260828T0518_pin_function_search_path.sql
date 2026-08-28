-- ============================================================================
-- Pin `search_path` on the four functions Supabase's security advisor flagged
-- as `function_search_path_mutable`.
--
-- APPLIED TO PRODUCTION 2026-08-28. Found by running the advisor as an
-- independent check after this session's DDL, rather than trusting that our own
-- review had caught everything — which is what the advisor is for.
--
-- ----------------------------------------------------------------------------
-- WHY IT MATTERS HERE, stated at its real severity rather than inflated.
--
-- None of the four is SECURITY DEFINER (`prosecdef = false`), which rules out
-- the classic escalation: an INVOKER function runs with the caller's own
-- privileges, so a hijacked search_path grants them nothing they did not
-- already have. All three auth helpers are also schema-qualified in their
-- bodies — `auth.uid()`, `auth.jwt() ->> 'role'` — so the names that actually
-- carry the security decision were never resolvable through search_path.
--
-- It is still worth pinning, because of where these are used:
--
--   current_auth_role   gates 61 RLS policies
--   current_auth_uid    gates 16
--   current_auth_email  gates 2
--
-- The whole RLS posture of this database is expressed in terms of three
-- functions, and a policy predicate is evaluated in the CALLER's context. Any
-- residual dependence on a caller-controlled setting in the functions the
-- policies call is worth removing on principle, and the removal is free.
--
-- ad_action_log_no_rewrite is the append-only trigger created earlier in this
-- same session, so that one was mine and should have carried this from the
-- start.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS SAFE. `ALTER FUNCTION ... SET` changes only the function's config;
-- it does not touch the body, the signature or the ACL. `pg_catalog` is
-- implicitly searched first regardless, so `lower()` and the `->>` operator
-- resolve exactly as before.
--
-- VERIFIED after applying:
--
--   all four now report  search_path=public, pg_temp
--   all three auth helpers execute without error (they return null under
--     service_role, which has no JWT — that is the expected answer, and the
--     point is that they RUN rather than raising and taking 68 policies with
--     them)
--   68 policies still reference them
--
--   www.vantalabsresearch.com  / /products /products/bpc-157 /cart /checkout
--                              /partner /membership /api/catalog/products
--                              -> 200 on all eight
--   catalogue: 36 products, 36 with dose sets
--
--   advisor re-run: all four `function_search_path_mutable` warnings cleared.
--
-- ----------------------------------------------------------------------------
-- WHAT THE ADVISOR STILL REPORTS, and why each is intended:
--
--   ~50 x INFO  rls_enabled_no_policy
--       This is the DESIRED state, not a gap. RLS on with no policy denies every
--       row to any role that does not bypass it, and RLS-05 additionally revoked
--       SELECT from anon and authenticated on all of them. The linter assumes a
--       policy-less RLS table is an oversight; here it is the lock.
--
--   2 x WARN    validate_referral_code executable by anon / authenticated
--       Deliberate and load-bearing. It is the referral-code check the cart
--       calls, it is the ONE anon-callable SECURITY DEFINER function in the
--       database, and referral-rpc-minimise.sql records why it must keep
--       returning customer_discount_percent.
--
--   1 x WARN    auth_leaked_password_protection disabled
--       NOT fixable from SQL — it is a Supabase Auth project setting. Left as
--       the single outstanding item; see docs/OWNER-DECISIONS.md.
-- ============================================================================

alter function public.current_auth_uid()         set search_path = public, pg_temp;
alter function public.current_auth_role()        set search_path = public, pg_temp;
alter function public.current_auth_email()       set search_path = public, pg_temp;
alter function public.ad_action_log_no_rewrite() set search_path = public, pg_temp;

-- Verification. All four must report `search_path=public, pg_temp`.
select p.proname,
       coalesce(array_to_string(p.proconfig, ', '), '(STILL MUTABLE)') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('current_auth_uid', 'current_auth_role', 'current_auth_email', 'ad_action_log_no_rewrite')
order by p.proname;

-- ============================================================================
-- ROLLBACK (there is no reason to, but for completeness):
--
--   alter function public.current_auth_uid()         reset search_path;
--   alter function public.current_auth_role()        reset search_path;
--   alter function public.current_auth_email()       reset search_path;
--   alter function public.ad_action_log_no_rewrite() reset search_path;
-- ============================================================================
