-- Focused follow-up migration for likely remaining Supabase advisor findings.
--
-- Safe goals only:
-- - Consolidate duplicate permissive ambassadors SELECT policies.
-- - Drop only exact duplicate indexes when another equivalent index already exists.
-- - Set a fixed search_path on public SECURITY DEFINER functions.
-- - Tighten Always True policies that are not required by the current website,
--   because the application uses server-side service-role access for those flows.
--
-- This migration does not change application code paths or data.

begin;

create or replace function public.current_auth_uid()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

create or replace function public.current_auth_role()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'role';
$$;

create or replace function pg_temp.run_sql_if_tables_exist(target_tables text[], sql text)
returns void
language plpgsql
as $$
declare
  target_table text;
begin
  foreach target_table in array target_tables loop
    if to_regclass(target_table) is null then
      return;
    end if;
  end loop;

  execute sql;
end;
$$;

create or replace function pg_temp.drop_index_if_exact_duplicate(index_name text)
returns void
language plpgsql
as $$
declare
  target_index oid;
  target_meta record;
  duplicate_exists boolean;
begin
  target_index := to_regclass(index_name);
  if target_index is null then
    return;
  end if;

  select
    idx.indexrelid,
    idx.indrelid,
    idx.indkey,
    idx.indclass,
    idx.indcollation,
    idx.indoption,
    idx.indexprs,
    idx.indpred
  into target_meta
  from pg_index idx
  where idx.indexrelid = target_index;

  if not found then
    return;
  end if;

  select exists (
    select 1
    from pg_index other
    where other.indrelid = target_meta.indrelid
      and other.indexrelid <> target_meta.indexrelid
      and other.indisvalid
      and other.indisready
      and other.indkey = target_meta.indkey
      and other.indclass = target_meta.indclass
      and other.indcollation = target_meta.indcollation
      and other.indoption = target_meta.indoption
      and pg_get_expr(other.indexprs, other.indrelid) is not distinct from pg_get_expr(target_meta.indexprs, target_meta.indrelid)
      and pg_get_expr(other.indpred, other.indrelid) is not distinct from pg_get_expr(target_meta.indpred, target_meta.indrelid)
  ) into duplicate_exists;

  if duplicate_exists then
    execute format('drop index if exists %s', index_name);
  end if;
end;
$$;

-- 1) Consolidate ambassadors SELECT visibility into one permissive policy.
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_select_owner on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_select_owner_or_admin on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(
  array['public.ambassadors'],
  'create policy ambassadors_select_owner_or_admin on public.ambassadors for select using (auth_user_id = (select public.current_auth_uid()) or (select public.current_auth_role()) = ''admin'')'
);

-- 2) Drop only truly redundant duplicate indexes.
-- These names are dropped only if another exact equivalent index already exists.
select pg_temp.drop_index_if_exact_duplicate('public.idx_products_slug');
select pg_temp.drop_index_if_exact_duplicate('public.idx_partners_auth_user_id');
select pg_temp.drop_index_if_exact_duplicate('public.idx_partners_referral_code');
select pg_temp.drop_index_if_exact_duplicate('public.idx_ambassadors_referral_code');
select pg_temp.drop_index_if_exact_duplicate('public.idx_admin_credentials_username');
select pg_temp.drop_index_if_exact_duplicate('public.idx_admin_sessions_token_hash');
select pg_temp.drop_index_if_exact_duplicate('public.idx_product_doses_product_slug_suffix');

-- 3) Fix SECURITY DEFINER search_path in public schema.
-- Use a fixed path that preserves common Supabase/public function resolution.
do $$
declare
  func_rec record;
begin
  for func_rec in
    select
      ns.nspname as schema_name,
      proc.proname as function_name,
      pg_get_function_identity_arguments(proc.oid) as identity_args,
      proc.proconfig
    from pg_proc proc
    join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public'
      and proc.prosecdef
  loop
    if not exists (
      select 1
      from unnest(coalesce(func_rec.proconfig, array[]::text[])) cfg
      where cfg like 'search_path=%'
    ) then
      execute format(
        'alter function %I.%I(%s) set search_path = pg_catalog, public, auth, extensions',
        func_rec.schema_name,
        func_rec.function_name,
        func_rec.identity_args
      );
    end if;
  end loop;
end
$$;

-- 4) Tighten Always True policies that are not required for current app flows.
-- The website uses server-side service-role access for these operations, so
-- removing public access does not change website behavior.
select pg_temp.run_sql_if_tables_exist(array['public.referrals'], 'drop policy if exists referrals_insert_any on public.referrals');
select pg_temp.run_sql_if_tables_exist(array['public.referrals'], 'drop policy if exists referrals_insert_admin on public.referrals');
select pg_temp.run_sql_if_tables_exist(
  array['public.referrals'],
  'create policy referrals_insert_admin on public.referrals for insert with check ((select public.current_auth_role()) = ''admin'')'
);

select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'drop policy if exists partner_clicks_insert_any on public.partner_clicks');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'drop policy if exists partner_clicks_insert_admin on public.partner_clicks');
select pg_temp.run_sql_if_tables_exist(
  array['public.partner_clicks'],
  'create policy partner_clicks_insert_admin on public.partner_clicks for insert with check ((select public.current_auth_role()) = ''admin'')'
);

select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'drop policy if exists website_analytics_events_insert_any on public.website_analytics_events');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'drop policy if exists website_analytics_events_insert_admin on public.website_analytics_events');
select pg_temp.run_sql_if_tables_exist(
  array['public.website_analytics_events'],
  'create policy website_analytics_events_insert_admin on public.website_analytics_events for insert with check ((select public.current_auth_role()) = ''admin'')'
);

select pg_temp.run_sql_if_tables_exist(array['public.partner_program_stats'], 'drop policy if exists partner_program_stats_select_public on public.partner_program_stats');
select pg_temp.run_sql_if_tables_exist(array['public.partner_program_stats'], 'drop policy if exists partner_program_stats_select_admin on public.partner_program_stats');
select pg_temp.run_sql_if_tables_exist(
  array['public.partner_program_stats'],
  'create policy partner_program_stats_select_admin on public.partner_program_stats for select using ((select public.current_auth_role()) = ''admin'')'
);

commit;