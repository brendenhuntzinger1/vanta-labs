-- ============================================================================
-- The ambassador commission ladder was readable by anyone holding the
-- storefront's publishable key.
--
-- APPLIED TO PRODUCTION 2026-08-28. Found by an adversarial security review of
-- the repository, then reproduced against production before anything changed.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG.
--
--   policy commission_tier_rules_read_all
--     polcmd        r          (SELECT)
--     polpermissive true
--     polroles      PUBLIC
--     polqual       true
--
-- plus a standing SELECT grant to anon. A permissive policy of `true` over a
-- granted table is not a lock at all. Reproduced with the storefront's own
-- publishable key:
--
--   GET /rest/v1/commission_tier_rules?select=*   -> 200
--     Starter  min_monthly_sales 10  commission_percent 10.00
--     Growth   min_monthly_sales 25  commission_percent 12.50
--     Elite    min_monthly_sales 50  commission_percent 15.00
--
-- Controls in the same probe, so it proves something rather than "everything is
-- open": public.orders -> 42501, public.referral_code_changes -> 42501.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS NOT PUBLIC INFORMATION, per this repository's own recorded
-- decisions — two of them, pointing the same way:
--
--   referral-rpc-minimise.sql — validate_referral_code deliberately omits
--     commission_percent. Its title is "stop handing out commission terms to
--     the internet".
--
--   public-program-terms.ts:33-38 — the 2026-08-27 audit found /ambassador and
--     /partner both advertising "15% Base Commission" *because 15 is the TOP
--     TIER of this very table*, while the programme default then paid 10. The
--     fix moved both pages onto the configured base rate. Publishing the whole
--     ladder undoes that finding from the other direction: it hands a reader the
--     top rate, the thresholds to reach it, and the shape of the whole scheme.
--
-- (For the record, the base rate was subsequently set to 15 —
-- default_commission_percent, 2026-08-27, "Owner decision: 15% is the advertised
-- base commission; align the programme default with the recruitment pages.
-- Previous value: 10." So the pages are truthful today. That does not make the
-- ladder public: the thresholds and the tier structure were never advertised.)
--
-- ----------------------------------------------------------------------------
-- WHY IT BREAKS NOTHING. Every reader is server-side under service_role, which
-- bypasses both RLS and grants:
--
--   ambassador-commission.ts:25,42,71,78   the admin CRUD
--   public-program-terms.ts                reads the CONFIGURED base rate, not
--                                          this table
--
-- No file importing the browser client (`@/lib/supabase`) references it.
--
-- ----------------------------------------------------------------------------
-- THE POLICY IS DROPPED, NOT JUST THE GRANT REVOKED. Either alone would close
-- today's hole. Leaving a `using (true)` policy behind is the loaded-gun shape
-- this project has spent the session removing: the day somebody re-grants
-- SELECT for an unrelated reason, the ladder is public again and nobody makes a
-- second decision about it. Deny-by-default, matching the 36 tables RLS-05
-- closed.
--
-- VERIFIED after applying:
--   policies on the table ......... 0
--   RLS enabled ................... true
--   anon SELECT ................... false
--   service_role SELECT ........... true
--   rows still present ............ 3   (nothing deleted)
--   re-probe with publishable key . 42501
--   /ambassador /partner / /products /api/catalog/products -> 200
-- ============================================================================

drop policy if exists "commission_tier_rules_read_all" on public.commission_tier_rules;

alter table public.commission_tier_rules enable row level security;
revoke all on public.commission_tier_rules from anon, authenticated;

-- Verification. Expect 0 policies, rls true, anon false, service_role true.
select 'policies'           as check, count(*)::text as value
  from pg_policy where polrelid = 'public.commission_tier_rules'::regclass
union all
select 'rls_enabled',        relrowsecurity::text from pg_class where oid = 'public.commission_tier_rules'::regclass
union all
select 'anon_select',        has_table_privilege('anon','public.commission_tier_rules','SELECT')::text
union all
select 'service_role_select', has_table_privilege('service_role','public.commission_tier_rules','SELECT')::text;

-- ============================================================================
-- ROLLBACK — only if the ladder is ever deliberately published, and then do it
-- as a named column grant rather than restoring a `using (true)` policy:
--
--   grant select (name, min_monthly_sales, commission_percent, position)
--     on public.commission_tier_rules to anon;
--
-- Note what that would still withhold: id, is_active, created_at, updated_at.
-- ============================================================================
