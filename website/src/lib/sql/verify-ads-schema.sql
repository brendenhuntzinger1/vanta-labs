-- =============================================================================
-- POST-MIGRATION VERIFICATION
--
-- Run this after ads-system.sql and analytics-creative-attribution.sql. It
-- proves the objects exist by querying the catalog rather than trusting that
-- the migration reported success — "no error" and "the schema is correct" are
-- different claims, and only the second one matters.
--
-- Every row comes back with PASS or FAIL. Read-only: no writes, no locks.
-- Expected result: 40 rows, all PASS.
-- =============================================================================

with expected_tables(name) as (
  values
    ('ad_reference_creatives'), ('ad_owner_taste_signals'), ('ad_patterns'),
    ('ad_pattern_observations'), ('ad_creatives'), ('ad_media_requests'),
    ('ad_platform_refs'), ('ad_experiments'), ('ad_experiment_arms'),
    ('ad_performance_daily'), ('ad_decisions'), ('ad_guardrails'), ('ad_action_log')
),
expected_indexes(name) as (
  values
    ('ad_reference_creatives_platform_idx'), ('ad_reference_creatives_company_idx'),
    ('ad_reference_creatives_observed_idx'), ('ad_owner_taste_signals_dimension_idx'),
    ('ad_creatives_concept_idx'), ('ad_creatives_status_idx'),
    ('ad_media_requests_status_idx'), ('ad_platform_refs_ad_idx'),
    ('ad_platform_refs_utm_idx'), ('ad_performance_daily_date_idx'),
    ('ad_action_log_at_idx')
),
expected_columns(tbl, col) as (
  values
    ('website_analytics_events','utm_content'),
    ('website_analytics_events','utm_term'),
    ('website_analytics_events','ttclid')
)

-- 1. Tables
select '1. table' as check_type, e.name as object_name,
       case when t.tablename is null then 'FAIL — missing' else 'PASS' end as result
  from expected_tables e
  left join pg_tables t on t.schemaname = 'public' and t.tablename = e.name

union all
-- 2. Indexes
select '2. index', e.name,
       case when i.indexname is null then 'FAIL — missing' else 'PASS' end
  from expected_indexes e
  left join pg_indexes i on i.schemaname = 'public' and i.indexname = e.name

union all
-- 3. The three additive analytics columns
select '3. column', e.tbl || '.' || e.col,
       case when c.column_name is null then 'FAIL — missing'
            when c.is_nullable <> 'YES' then 'FAIL — must be nullable'
            else 'PASS (nullable ' || c.data_type || ')' end
  from expected_columns e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col

union all
-- 4. RLS enabled on every ad table. Deny-by-default: enabled with no policy
--    means only the service-role key can read, which is what we want for a
--    table holding competitor analysis, spend and the owner's judgements.
select '4. rls', e.name,
       case when c.relrowsecurity is true then 'PASS' else 'FAIL — RLS not enabled' end
  from expected_tables e
  left join pg_class c on c.relname = e.name
   and c.relnamespace = 'public'::regnamespace

union all
-- 5. The derived-metrics view
select '5. view', 'ad_performance_derived',
       case when count(*) = 1 then 'PASS' else 'FAIL — missing' end
  from pg_views where schemaname = 'public' and viewname = 'ad_performance_derived'

union all
-- 6. Append-only enforcement on the action log
select '6. function', 'ad_action_log_no_rewrite',
       case when count(*) = 1 then 'PASS' else 'FAIL — missing' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'ad_action_log_no_rewrite'

union all
select '7. trigger', 'ad_action_log_no_rewrite_trg',
       case when count(*) = 1 then 'PASS' else 'FAIL — missing' end
  from pg_trigger where tgname = 'ad_action_log_no_rewrite_trg' and not tgisinternal

union all
-- 8. Guardrails seeded, and seeded SAFE. A row that exists but says
--    'autonomous' would be worse than no row at all.
select '8. guardrails', 'single row, deny-by-default',
       case when count(*) = 0 then 'FAIL — not seeded'
            when count(*) > 1 then 'FAIL — more than one row'
            when bool_and(mode = 'recommend' and frozen = false) then 'PASS (mode=recommend)'
            else 'FAIL — seeded in a non-default mode' end
  from public.ad_guardrails

union all
-- 9. Foreign keys point only at ad_* tables. Any FK from this schema into a
--    commerce table would couple advertising to orders, which is the one
--    structural mistake this design exists to avoid.
select '9. isolation', 'no FK into commerce tables',
       case when count(*) = 0 then 'PASS'
            else 'FAIL — ' || count(*) || ' FK(s) reach outside ad_*' end
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
 where tc.constraint_type = 'FOREIGN KEY'
   and tc.table_schema = 'public'
   and tc.table_name like 'ad\_%'
   and ccu.table_name not like 'ad\_%'

order by 1, 2;

-- -----------------------------------------------------------------------------
-- 10. Prove the append-only trigger actually bites. Run separately; it is
--     expected to RAISE, and it rolls itself back either way.
-- -----------------------------------------------------------------------------
-- begin;
--   insert into public.ad_action_log (action_id, action_type, rationale)
--   values ('verify-1', 'pause_ad', 'verification probe');
--   -- Expect: ERROR "ad_action_log is append-only; only reverted_by may change"
--   update public.ad_action_log set rationale = 'tampered' where action_id = 'verify-1';
-- rollback;
--
-- And that the permitted update still works:
-- begin;
--   insert into public.ad_action_log (action_id, action_type, rationale)
--   values ('verify-2', 'pause_ad', 'verification probe');
--   update public.ad_action_log set reverted_by = 'verify-3' where action_id = 'verify-2';  -- allowed
--   delete from public.ad_action_log where action_id = 'verify-2';  -- expect ERROR
-- rollback;
