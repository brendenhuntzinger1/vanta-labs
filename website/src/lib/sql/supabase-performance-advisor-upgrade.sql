-- One-shot live upgrade for Supabase Performance Advisor findings.
-- Safe to run in Supabase SQL Editor against an existing project.
-- This migration preserves data and access semantics while rebuilding
-- policy definitions with cached auth lookups and adding missing indexes.

begin;

-- Cache auth lookups so policy expressions do not repeatedly execute auth.*
-- functions per row during query evaluation.
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

-- Supporting indexes used by joins and RLS filters.
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
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create index if not exists idx_ambassadors_status on public.ambassadors(status)');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create index if not exists idx_ambassadors_updated_at on public.ambassadors(updated_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'create index if not exists idx_partner_clicks_created_at on public.partner_clicks(created_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'create index if not exists idx_partner_clicks_referral_code on public.partner_clicks(referral_code)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id)');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'create index if not exists idx_partner_payouts_created_at on public.partner_payouts(created_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'create index if not exists idx_admin_audit_logs_actor on public.admin_audit_logs(actor_user_id)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'create index if not exists idx_admin_audit_logs_created_at on public.admin_audit_logs(created_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'create unique index if not exists idx_admin_credentials_username on public.admin_credentials(username)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'create unique index if not exists idx_admin_sessions_token_hash on public.admin_sessions(token_hash)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'create index if not exists idx_admin_sessions_expires_at on public.admin_sessions(expires_at)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'create index if not exists idx_admin_login_attempts_username_attempted_at on public.admin_login_attempts(username, attempted_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'create index if not exists idx_admin_login_attempts_ip_attempted_at on public.admin_login_attempts(ip_address, attempted_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.order_shipments'], 'create index if not exists idx_order_shipments_order_id on public.order_shipments(order_id)');
select pg_temp.run_sql_if_tables_exist(array['public.notification_queue'], 'create index if not exists idx_notification_queue_status on public.notification_queue(status, created_at)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create index if not exists idx_website_analytics_events_created_at on public.website_analytics_events(created_at desc)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create index if not exists idx_website_analytics_events_event_type on public.website_analytics_events(event_type)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create index if not exists idx_website_analytics_events_page_path on public.website_analytics_events(page_path)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create index if not exists idx_website_analytics_events_session_id on public.website_analytics_events(session_id)');

-- Ensure RLS is enabled on all protected tables.
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_events enable row level security;
alter table public.referral_orders enable row level security;
alter table public.partners enable row level security;
alter table public.referrals enable row level security;
alter table public.commissions enable row level security;
alter table public.payouts enable row level security;
alter table public.partner_program_stats enable row level security;
alter table public.products enable row level security;
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'alter table public.product_images enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'alter table public.product_doses enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'alter table public.ambassadors enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'alter table public.partner_clicks enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'alter table public.partner_payouts enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'alter table public.admin_audit_logs enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'alter table public.admin_credentials enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'alter table public.admin_sessions enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'alter table public.admin_login_attempts enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.inventory_items'], 'alter table public.inventory_items enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.order_shipments'], 'alter table public.order_shipments enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.coupons'], 'alter table public.coupons enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.notification_queue'], 'alter table public.notification_queue enable row level security');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'alter table public.website_analytics_events enable row level security');

-- Canonical order and payment policies.
drop policy if exists orders_select_admin on public.orders;
drop policy if exists orders_select_partner on public.orders;
drop policy if exists orders_select_owner_or_admin on public.orders;
select pg_temp.run_sql_if_tables_exist(
  array['public.orders', 'public.ambassadors'],
  'create policy orders_select_owner_or_admin on public.orders for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')'
);
select pg_temp.run_sql_if_tables_exist(
  array['public.orders'],
  'create policy orders_select_admin on public.orders for select using ((select public.current_auth_role()) = ''admin'')'
)
where to_regclass('public.ambassadors') is null;

drop policy if exists orders_insert_admin on public.orders;
create policy orders_insert_admin on public.orders
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists orders_update_admin on public.orders;
create policy orders_update_admin on public.orders
for update
using ((select public.current_auth_role()) = 'admin');

drop policy if exists order_items_select_admin on public.order_items;
create policy order_items_select_admin on public.order_items
for select
using ((select public.current_auth_role()) = 'admin');

drop policy if exists order_items_insert_admin on public.order_items;
create policy order_items_insert_admin on public.order_items
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists order_items_update_admin on public.order_items;
create policy order_items_update_admin on public.order_items
for update
using ((select public.current_auth_role()) = 'admin');

drop policy if exists payment_events_select_admin on public.payment_events;
create policy payment_events_select_admin on public.payment_events
for select
using ((select public.current_auth_role()) = 'admin');

drop policy if exists payment_events_insert_admin on public.payment_events;
create policy payment_events_insert_admin on public.payment_events
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists referral_orders_select_admin on public.referral_orders;
drop policy if exists referral_orders_select_partner on public.referral_orders;
drop policy if exists referral_orders_select_owner_or_admin on public.referral_orders;
select pg_temp.run_sql_if_tables_exist(
  array['public.referral_orders', 'public.ambassadors'],
  'create policy referral_orders_select_owner_or_admin on public.referral_orders for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')'
);
select pg_temp.run_sql_if_tables_exist(
  array['public.referral_orders'],
  'create policy referral_orders_select_admin on public.referral_orders for select using ((select public.current_auth_role()) = ''admin'')'
)
where to_regclass('public.ambassadors') is null;

drop policy if exists referral_orders_insert_admin on public.referral_orders;
create policy referral_orders_insert_admin on public.referral_orders
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists referral_orders_update_admin on public.referral_orders;
create policy referral_orders_update_admin on public.referral_orders
for update
using ((select public.current_auth_role()) = 'admin');

-- Canonical affiliate policies.
drop policy if exists partners_select_owner_or_admin on public.partners;
create policy partners_select_owner_or_admin on public.partners
for select
using (
  auth_user_id = (select public.current_auth_uid())
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists partners_insert_admin on public.partners;
create policy partners_insert_admin on public.partners
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists partners_update_admin on public.partners;
create policy partners_update_admin on public.partners
for update
using ((select public.current_auth_role()) = 'admin');

drop policy if exists referrals_select_owner_or_admin on public.referrals;
create policy referrals_select_owner_or_admin on public.referrals
for select
using (
  partner_id in (
    select id from public.partners where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists referrals_insert_any on public.referrals;
create policy referrals_insert_any on public.referrals
for insert
with check (true);

drop policy if exists commissions_select_owner_or_admin on public.commissions;
create policy commissions_select_owner_or_admin on public.commissions
for select
using (
  partner_id in (
    select id from public.partners where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists commissions_insert_admin on public.commissions;
create policy commissions_insert_admin on public.commissions
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists commissions_update_admin on public.commissions;
create policy commissions_update_admin on public.commissions
for update
using ((select public.current_auth_role()) = 'admin');

drop policy if exists payouts_select_owner_or_admin on public.payouts;
create policy payouts_select_owner_or_admin on public.payouts
for select
using (
  partner_id in (
    select id from public.partners where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists payouts_insert_admin on public.payouts;
create policy payouts_insert_admin on public.payouts
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists partner_program_stats_select_public on public.partner_program_stats;
create policy partner_program_stats_select_public on public.partner_program_stats
for select
using (true);

drop policy if exists partner_program_stats_insert_admin on public.partner_program_stats;
create policy partner_program_stats_insert_admin on public.partner_program_stats
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists partner_program_stats_update_admin on public.partner_program_stats;
create policy partner_program_stats_update_admin on public.partner_program_stats
for update
using ((select public.current_auth_role()) = 'admin');

-- Catalog and storefront policies.
drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
for select
using (
  (is_active = true and is_archived = false and is_enabled = true and is_published = true)
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists products_insert_admin on public.products;
create policy products_insert_admin on public.products
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists products_update_admin on public.products;
create policy products_update_admin on public.products
for update
using ((select public.current_auth_role()) = 'admin');

select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'drop policy if exists product_images_select_public on public.product_images');
select pg_temp.run_sql_if_tables_exist(array['public.product_images', 'public.products'], 'create policy product_images_select_public on public.product_images for select using (exists (select 1 from public.products p where p.id = product_id and ((p.is_active = true and p.is_archived = false and p.is_enabled = true and p.is_published = true) or (select public.current_auth_role()) = ''admin'')))');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'drop policy if exists product_images_insert_admin on public.product_images');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'create policy product_images_insert_admin on public.product_images for insert with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'drop policy if exists product_images_update_admin on public.product_images');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'create policy product_images_update_admin on public.product_images for update using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'drop policy if exists product_images_delete_admin on public.product_images');
select pg_temp.run_sql_if_tables_exist(array['public.product_images'], 'create policy product_images_delete_admin on public.product_images for delete using ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'drop policy if exists product_doses_select_public on public.product_doses');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses', 'public.products'], 'create policy product_doses_select_public on public.product_doses for select using (exists (select 1 from public.products p where p.id = product_id and ((p.is_active = true and p.is_archived = false and p.is_enabled = true and p.is_published = true) or (select public.current_auth_role()) = ''admin'')))');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'drop policy if exists product_doses_insert_admin on public.product_doses');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create policy product_doses_insert_admin on public.product_doses for insert with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'drop policy if exists product_doses_update_admin on public.product_doses');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create policy product_doses_update_admin on public.product_doses for update using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'drop policy if exists product_doses_delete_admin on public.product_doses');
select pg_temp.run_sql_if_tables_exist(array['public.product_doses'], 'create policy product_doses_delete_admin on public.product_doses for delete using ((select public.current_auth_role()) = ''admin'')');

-- Ambassador, admin, inventory, and analytics policies.
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_select_owner on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_select_owner_or_admin on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create policy ambassadors_select_owner_or_admin on public.ambassadors for select using (auth_user_id = (select public.current_auth_uid()) or (select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_insert_admin on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create policy ambassadors_insert_admin on public.ambassadors for insert with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'drop policy if exists ambassadors_update_admin on public.ambassadors');
select pg_temp.run_sql_if_tables_exist(array['public.ambassadors'], 'create policy ambassadors_update_admin on public.ambassadors for update using ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'drop policy if exists partner_clicks_select_owner on public.partner_clicks');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'drop policy if exists partner_clicks_select_owner_or_admin on public.partner_clicks');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks', 'public.ambassadors'], 'create policy partner_clicks_select_owner_or_admin on public.partner_clicks for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'drop policy if exists partner_clicks_insert_any on public.partner_clicks');
select pg_temp.run_sql_if_tables_exist(array['public.partner_clicks'], 'create policy partner_clicks_insert_any on public.partner_clicks for insert with check (true)');

select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'drop policy if exists partner_payouts_select_owner on public.partner_payouts');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'drop policy if exists partner_payouts_select_owner_or_admin on public.partner_payouts');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts', 'public.ambassadors'], 'create policy partner_payouts_select_owner_or_admin on public.partner_payouts for select using (ambassador_id in (select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())) or (select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'drop policy if exists partner_payouts_insert_admin on public.partner_payouts');
select pg_temp.run_sql_if_tables_exist(array['public.partner_payouts'], 'create policy partner_payouts_insert_admin on public.partner_payouts for insert with check ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'drop policy if exists admin_audit_logs_admin_only on public.admin_audit_logs');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'create policy admin_audit_logs_admin_only on public.admin_audit_logs for select using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'drop policy if exists admin_audit_logs_insert_admin on public.admin_audit_logs');
select pg_temp.run_sql_if_tables_exist(array['public.admin_audit_logs'], 'create policy admin_audit_logs_insert_admin on public.admin_audit_logs for insert with check ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'drop policy if exists admin_credentials_admin_only on public.admin_credentials');
select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'create policy admin_credentials_admin_only on public.admin_credentials for select using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'drop policy if exists admin_credentials_admin_update on public.admin_credentials');
select pg_temp.run_sql_if_tables_exist(array['public.admin_credentials'], 'create policy admin_credentials_admin_update on public.admin_credentials for update using ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'drop policy if exists admin_sessions_admin_only on public.admin_sessions');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'create policy admin_sessions_admin_only on public.admin_sessions for select using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'drop policy if exists admin_sessions_admin_insert on public.admin_sessions');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'create policy admin_sessions_admin_insert on public.admin_sessions for insert with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'drop policy if exists admin_sessions_admin_delete on public.admin_sessions');
select pg_temp.run_sql_if_tables_exist(array['public.admin_sessions'], 'create policy admin_sessions_admin_delete on public.admin_sessions for delete using ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'drop policy if exists admin_login_attempts_admin_only on public.admin_login_attempts');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'create policy admin_login_attempts_admin_only on public.admin_login_attempts for select using ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'drop policy if exists admin_login_attempts_admin_insert on public.admin_login_attempts');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'create policy admin_login_attempts_admin_insert on public.admin_login_attempts for insert with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'drop policy if exists admin_login_attempts_admin_delete on public.admin_login_attempts');
select pg_temp.run_sql_if_tables_exist(array['public.admin_login_attempts'], 'create policy admin_login_attempts_admin_delete on public.admin_login_attempts for delete using ((select public.current_auth_role()) = ''admin'')');

select pg_temp.run_sql_if_tables_exist(array['public.inventory_items'], 'drop policy if exists inventory_items_admin_only on public.inventory_items');
select pg_temp.run_sql_if_tables_exist(array['public.inventory_items'], 'create policy inventory_items_admin_only on public.inventory_items for all using ((select public.current_auth_role()) = ''admin'') with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.order_shipments'], 'drop policy if exists order_shipments_admin_only on public.order_shipments');
select pg_temp.run_sql_if_tables_exist(array['public.order_shipments'], 'create policy order_shipments_admin_only on public.order_shipments for all using ((select public.current_auth_role()) = ''admin'') with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.coupons'], 'drop policy if exists coupons_admin_only on public.coupons');
select pg_temp.run_sql_if_tables_exist(array['public.coupons'], 'create policy coupons_admin_only on public.coupons for all using ((select public.current_auth_role()) = ''admin'') with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.notification_queue'], 'drop policy if exists notification_queue_admin_only on public.notification_queue');
select pg_temp.run_sql_if_tables_exist(array['public.notification_queue'], 'create policy notification_queue_admin_only on public.notification_queue for all using ((select public.current_auth_role()) = ''admin'') with check ((select public.current_auth_role()) = ''admin'')');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'drop policy if exists website_analytics_events_insert_any on public.website_analytics_events');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create policy website_analytics_events_insert_any on public.website_analytics_events for insert with check (true)');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'drop policy if exists website_analytics_events_select_admin on public.website_analytics_events');
select pg_temp.run_sql_if_tables_exist(array['public.website_analytics_events'], 'create policy website_analytics_events_select_admin on public.website_analytics_events for select using ((select public.current_auth_role()) = ''admin'')');

commit;