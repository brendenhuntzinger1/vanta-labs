-- Final production migration for Supabase Performance Advisor cleanup.
--
-- Run this after supabase-performance-advisor-upgrade.sql.
-- It is idempotent and safe to rerun.
--
-- What it does:
-- 1. Ensures the cached auth helper functions exist.
-- 2. Re-applies the known safe index and policy fixes.
-- 3. Rewrites any remaining live public-schema policies that still use
--    auth.uid(), auth.jwt(), auth.role(), or the standard Supabase JWT
--    current_setting(...) patterns.
--
-- What it intentionally does not rewrite:
-- - Arbitrary current_setting(...) expressions unrelated to standard Supabase
--   JWT role/sub claims, because changing those generically could alter
--   behavior.

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

create or replace function pg_temp.roles_sql(target_roles name[])
returns text
language sql
as $$
  select string_agg(
    case when role_name = 'public' then 'public' else quote_ident(role_name) end,
    ', '
    order by role_name
  )
  from unnest(target_roles) role_name;
$$;

create or replace function pg_temp.rewrite_policy_expr(input text)
returns text
language plpgsql
as $$
declare
  output text := input;
begin
  if output is null then
    return null;
  end if;

  output := regexp_replace(output, '\mauth\.uid\(\)', '(select public.current_auth_uid())', 'gi');
  output := regexp_replace(output, 'auth\.jwt\(\)\s*->>\s*''role''', '(select public.current_auth_role())', 'gi');
  output := regexp_replace(output, '\mauth\.role\(\)', '(select public.current_auth_role())', 'gi');

  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.role''\s*,\s*true\)',
    '(select public.current_auth_role())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.role''\s*,\s*true\)',
    '(select public.current_auth_role())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.role''\)',
    '(select public.current_auth_role())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.role''\)',
    '(select public.current_auth_role())',
    'gi'
  );

  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.sub''\s*,\s*true\)::uuid',
    '(select public.current_auth_uid())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.sub''\s*,\s*true\)::uuid',
    '(select public.current_auth_uid())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.sub''\)::uuid',
    '(select public.current_auth_uid())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.sub''\)::uuid',
    '(select public.current_auth_uid())',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.sub''\s*,\s*true\)',
    '((select public.current_auth_uid()))::text',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.sub''\s*,\s*true\)',
    '((select public.current_auth_uid()))::text',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claims\.sub''\)',
    '((select public.current_auth_uid()))::text',
    'gi'
  );
  output := regexp_replace(
    output,
    'current_setting\(''request\.jwt\.claim\.sub''\)',
    '((select public.current_auth_uid()))::text',
    'gi'
  );

  return output;
end;
$$;

-- Re-apply the known schema/index hardening. Safe to rerun.
create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_payment_status on public.orders(payment_status);
create index if not exists idx_orders_ambassador_id on public.orders(ambassador_id);
create index if not exists idx_orders_referral_code on public.orders(referral_code);
create index if not exists idx_orders_customer_email on public.orders(customer_email);
create index if not exists idx_payment_events_order_id on public.payment_events(order_id);
create index if not exists idx_referral_orders_ambassador_id on public.referral_orders(ambassador_id);
create index if not exists idx_referral_orders_order_id on public.referral_orders(order_id);
create index if not exists idx_referral_orders_payment_status on public.referral_orders(payment_status);
create index if not exists idx_partners_status on public.partners(status);
create index if not exists idx_partners_auth_user_id on public.partners(auth_user_id);
create index if not exists idx_partners_updated_at on public.partners(updated_at desc);
create index if not exists idx_partners_referral_code on public.partners(referral_code);
create index if not exists idx_referrals_partner_id on public.referrals(partner_id);
create index if not exists idx_referrals_order_id on public.referrals(order_id);
create index if not exists idx_referrals_event_type on public.referrals(event_type);
create index if not exists idx_referrals_created_at on public.referrals(created_at desc);
create index if not exists idx_commissions_partner_id on public.commissions(partner_id);
create index if not exists idx_commissions_status on public.commissions(status);
create index if not exists idx_payouts_partner_id on public.payouts(partner_id);
create index if not exists idx_payouts_created_at on public.payouts(created_at desc);
create unique index if not exists idx_products_slug on public.products(slug);
create index if not exists idx_products_is_active on public.products(is_active);
create index if not exists idx_products_category on public.products(category);
create index if not exists idx_products_position on public.products(position);
create index if not exists idx_products_is_published on public.products(is_published);
create index if not exists idx_products_is_enabled on public.products(is_enabled);
create index if not exists idx_products_is_archived on public.products(is_archived);
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'create index if not exists idx_product_images_product_id on public.product_images(product_id)');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'create index if not exists idx_product_images_position on public.product_images(position)');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create index if not exists idx_product_doses_product_id on public.product_doses(product_id)');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create index if not exists idx_product_doses_position on public.product_doses(position)');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create unique index if not exists idx_product_doses_product_slug_suffix on public.product_doses(product_id, slug_suffix)');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create index if not exists idx_ambassadors_auth_user_id on public.ambassadors(auth_user_id)');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create index if not exists idx_ambassadors_referral_code on public.ambassadors(referral_code)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create index if not exists idx_website_analytics_events_created_at on public.website_analytics_events(created_at desc)');

-- Clean up and reapply the most important known policy shapes.
select pg_temp.run_sql_if_tables_exist(array['public.orders'], 'drop policy if exists orders_select_admin on public.orders');
select pg_temp.run_sql_if_tables_exist(array['public.orders'], 'drop policy if exists orders_select_partner on public.orders');
select pg_temp.run_sql_if_tables_exist(array['public.orders'], 'drop policy if exists orders_select_owner_or_admin on public.orders');
select pg_temp.run_sql_if_tables_exist(array['public.orders', 'public.ambassadors'], 'create policy orders_select_owner_or_admin on public.orders for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.orders'], 'create policy orders_select_admin on public.orders for select using ((select public.current_auth_role()) = ''admin'')')
where to_regclass('public.ambassadors') is null;

select pg_temp.run_sql_if_tables_exist(array['public.referral_orders'], 'drop policy if exists referral_orders_select_admin on public.referral_orders');
select pg_temp.run_sql_if_tables_exist(array['public.referral_orders'], 'drop policy if exists referral_orders_select_partner on public.referral_orders');
select pg_temp.run_sql_if_tables_exist(array['public.referral_orders'], 'drop policy if exists referral_orders_select_owner_or_admin on public.referral_orders');
select pg_temp.run_sql_if_tables_exist(array['public.referral_orders', 'public.ambassadors'], 'create policy referral_orders_select_owner_or_admin on public.referral_orders for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.referral_orders'], 'create policy referral_orders_select_admin on public.referral_orders for select using ((select public.current_auth_role()) = ''admin'')')
where to_regclass('public.ambassadors') is null;

-- Rewrite any remaining live policies in public schema that still reference
-- the standard slow auth/current_setting patterns.
do $$
declare
  rec record;
  new_qual text;
  new_with_check text;
  roles_clause text;
  create_sql text;
begin
  for rec in
    select *
    from pg_policies
    where schemaname = 'public'
      and (
        coalesce(qual, '') ~* 'auth\.(uid|jwt|role)\s*\('
        or coalesce(with_check, '') ~* 'auth\.(uid|jwt|role)\s*\('
        or coalesce(qual, '') ~* 'current_setting\(''request\.jwt\.claim(s)?\.(role|sub)'''
        or coalesce(with_check, '') ~* 'current_setting\(''request\.jwt\.claim(s)?\.(role|sub)'''
      )
  loop
    new_qual := pg_temp.rewrite_policy_expr(rec.qual);
    new_with_check := pg_temp.rewrite_policy_expr(rec.with_check);

    if new_qual is not distinct from rec.qual and new_with_check is not distinct from rec.with_check then
      continue;
    end if;

    roles_clause := pg_temp.roles_sql(rec.roles);

    execute format('drop policy if exists %I on %I.%I', rec.policyname, rec.schemaname, rec.tablename);

    create_sql := format(
      'create policy %I on %I.%I as %s for %s to %s',
      rec.policyname,
      rec.schemaname,
      rec.tablename,
      lower(rec.permissive),
      rec.cmd,
      roles_clause
    );

    if new_qual is not null then
      create_sql := create_sql || format(' using (%s)', new_qual);
    end if;

    if new_with_check is not null then
      create_sql := create_sql || format(' with check (%s)', new_with_check);
    end if;

    execute create_sql;
  end loop;
end
$$;

commit;