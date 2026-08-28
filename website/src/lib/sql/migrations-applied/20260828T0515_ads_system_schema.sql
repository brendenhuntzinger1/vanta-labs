-- ============================================================================
-- VL-SQL-03 (remaining half) — the ads operating-system schema.
--
-- APPLIED TO PRODUCTION 2026-08-28 as Supabase migration `ads_system_schema`,
-- under the owner's standing authorisation to decide and proceed. The full DDL
-- is src/lib/sql/ads-system.sql; this file records that it ran, what was
-- verified, and the one deliberate deviation.
--
-- ----------------------------------------------------------------------------
-- WHY IT WAS SAFE TO DEPLOY, checked rather than asserted.
--
--   * 13 new tables, one view, one trigger, one seeded guardrails row. Every
--     statement `create ... if not exists`.
--   * Touches NO commerce table. Verified by grep across the whole file for
--     orders, order_items, products, customers, payments, coupons, referral and
--     ambassador — zero matches. The ad system observes commerce through one
--     join key (utm_content == creative_id) and never writes to it.
--   * dashboard-data.ts already degraded cleanly on its absence (42P01), so
--     nothing that worked before could break; what changes is that the ads
--     dashboard now has somewhere to read from.
--
-- ----------------------------------------------------------------------------
-- THE DEVIATION, and it is a tightening. ads-system.sql section 6 enables RLS
-- on all thirteen and stops there. The production run additionally did
--
--   revoke all on public.<table> from anon, authenticated
--
-- for each, matching the posture set by
-- 20260828T0245_rls05_revoke_select_policyless_rls_tables.sql. A policy-less RLS
-- table already returns zero rows to a client key, so this changes no answer
-- today. It means a future permissive policy is not, on its own, enough to
-- publish the store's ad spend, CPA and ROAS — which is exactly what section 6's
-- own comment says must never be readable from a browser.
--
-- Applying it AT CREATION rather than sweeping it up later also means these
-- thirteen never spent a moment in the state the RLS-05 sweep existed to fix.
--
-- ----------------------------------------------------------------------------
-- VERIFIED immediately after applying:
--
--   ad_ tables in public ............... 14  (13 new + ad_purchase_events_sent)
--   of those, RLS enabled .............. 14
--   of those, anon can SELECT ..........  0
--   of those, anon can INSERT ..........  0
--   ad_performance_derived
--     security_invoker ................. true
--     anon SELECT ...................... false
--   ad_guardrails.mode ................. 'recommend'   <- cannot autonomously spend
--   tables in public ................... 70 -> 83
--
-- The guardrails row matters as much as the grants: `mode = 'recommend'` is the
-- deny-by-default state, so nothing in this system can move a budget on its own
-- until somebody changes that value on purpose.
--
-- `security_invoker = true` on the view is load-bearing and was the one
-- pre-apply fix this file needed. ad_performance_daily has RLS with no policy,
-- but a view created WITHOUT invoker rights runs as its owner, and a table's
-- owner is exempt from that table's RLS — so the view would have been an
-- unauthenticated read of the store's entire ad spend and ROAS.
--
-- production-schema.json was regenerated in the same commit, so
-- supabase-schema-parity.test.ts keeps its teeth over the new tables: 85 tables
-- in the snapshot, and the coupons and website_analytics_events additions from
-- earlier in this session are intact.
--
-- ----------------------------------------------------------------------------
-- ROLLBACK. Nothing depends on these tables yet, so they can be dropped
-- outright. Do it in dependency order, or use cascade:
--
--   drop view if exists public.ad_performance_derived;
--   drop trigger if exists ad_action_log_no_rewrite_trg on public.ad_action_log;
--   drop function if exists public.ad_action_log_no_rewrite();
--   drop table if exists public.ad_action_log, public.ad_guardrails,
--     public.ad_decisions, public.ad_performance_daily,
--     public.ad_experiment_arms, public.ad_experiments,
--     public.ad_platform_refs, public.ad_media_requests, public.ad_creatives,
--     public.ad_pattern_observations, public.ad_patterns,
--     public.ad_owner_taste_signals, public.ad_reference_creatives cascade;
--
-- Do NOT drop public.ad_purchase_events_sent — it predates this migration, is
-- the Purchase conversion ledger, and is live.
-- ============================================================================

-- The DDL itself lives in src/lib/sql/ads-system.sql and is not duplicated here:
-- it is 355 lines, it is unchanged apart from the header, and two copies of a
-- schema definition is how they drift. Re-run that file, then apply the
-- RLS-05 revoke below, which is the only thing this migration added on top.

do $rls05_for_ads$
declare t text;
begin
  foreach t in array array[
    'ad_reference_creatives','ad_owner_taste_signals','ad_patterns','ad_pattern_observations',
    'ad_creatives','ad_media_requests','ad_platform_refs','ad_experiments','ad_experiment_arms',
    'ad_performance_daily','ad_decisions','ad_guardrails','ad_action_log'
  ]
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$rls05_for_ads$;

revoke all on function public.ad_action_log_no_rewrite() from public;

-- Verification. Every count must be 14 / 14 / 0 / 0.
select 'ad_ tables'          as metric, count(*)::text as value from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'ad\_%'
union all
select 'RLS enabled',          count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'ad\_%' and c.relrowsecurity
union all
select 'anon can SELECT',      count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'ad\_%' and has_table_privilege('anon',c.oid,'SELECT')
union all
select 'anon can INSERT',      count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'ad\_%' and has_table_privilege('anon',c.oid,'INSERT');
