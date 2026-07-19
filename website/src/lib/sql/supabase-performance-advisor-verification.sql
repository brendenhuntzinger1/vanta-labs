-- Verification queries for the live Supabase project after running
-- supabase-performance-advisor-upgrade.sql.
--
-- Run this in Supabase SQL Editor. Review each result set:
-- - PASS-style result sets should show expected rows.
-- - Remaining issues result sets should be empty.

-- 1) Helper functions used to cache auth lookups should exist.
select
  routine_name,
  case when routine_name is not null then 'PASS' else 'FAIL' end as status
from (
  values ('current_auth_uid'), ('current_auth_role')
) expected(routine_name)
left join information_schema.routines routines
  on routines.routine_schema = 'public'
 and routines.routine_name = expected.routine_name
 and routines.routine_type = 'FUNCTION';

-- 2) No RLS policy expression should directly call auth.uid(), auth.jwt(),
-- auth.role(), or current_setting(). This should be empty.
select
  schemaname,
  tablename,
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and coalesce(qual, '') ~* 'auth\.(uid|jwt|role)\s*\('
   or coalesce(with_check, '') ~* 'auth\.(uid|jwt|role)\s*\('
   or coalesce(qual, '') ~* 'current_setting\s*\('
   or coalesce(with_check, '') ~* 'current_setting\s*\('
order by schemaname, tablename, policyname;

-- 3) Helper functions should be the only auth lookup wrappers in policy text.
-- This should show the optimized policies, not raw auth.* calls.
select
  schemaname,
  tablename,
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and (
    coalesce(qual, '') ilike '%current_auth_uid%'
    or coalesce(qual, '') ilike '%current_auth_role%'
    or coalesce(with_check, '') ilike '%current_auth_uid%'
    or coalesce(with_check, '') ilike '%current_auth_role%'
  )
order by tablename, policyname;

-- 4) Legacy duplicate policy names should be gone. This should be empty.
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and (
    (tablename = 'orders' and policyname in ('orders_select_admin', 'orders_select_partner'))
    or (tablename = 'referral_orders' and policyname in ('referral_orders_select_admin', 'referral_orders_select_partner'))
    or (tablename = 'ambassadors' and policyname = 'ambassadors_select_owner')
    or (tablename = 'partner_clicks' and policyname = 'partner_clicks_select_owner')
    or (tablename = 'partner_payouts' and policyname = 'partner_payouts_select_owner')
  )
order by tablename, policyname;

-- 5) Final expected policies should exist when their tables exist.
with expected_policies as (
  select * from (values
    ('public.orders', 'orders_select_owner_or_admin'),
    ('public.orders', 'orders_insert_admin'),
    ('public.orders', 'orders_update_admin'),
    ('public.order_items', 'order_items_select_admin'),
    ('public.order_items', 'order_items_insert_admin'),
    ('public.order_items', 'order_items_update_admin'),
    ('public.payment_events', 'payment_events_select_admin'),
    ('public.payment_events', 'payment_events_insert_admin'),
    ('public.referral_orders', 'referral_orders_select_owner_or_admin'),
    ('public.referral_orders', 'referral_orders_insert_admin'),
    ('public.referral_orders', 'referral_orders_update_admin'),
    ('public.partners', 'partners_select_owner_or_admin'),
    ('public.partners', 'partners_insert_admin'),
    ('public.partners', 'partners_update_admin'),
    ('public.referrals', 'referrals_select_owner_or_admin'),
    ('public.referrals', 'referrals_insert_any'),
    ('public.commissions', 'commissions_select_owner_or_admin'),
    ('public.commissions', 'commissions_insert_admin'),
    ('public.commissions', 'commissions_update_admin'),
    ('public.payouts', 'payouts_select_owner_or_admin'),
    ('public.payouts', 'payouts_insert_admin'),
    ('public.partner_program_stats', 'partner_program_stats_select_public'),
    ('public.partner_program_stats', 'partner_program_stats_insert_admin'),
    ('public.partner_program_stats', 'partner_program_stats_update_admin'),
    ('public.products', 'products_select_public'),
    ('public.products', 'products_insert_admin'),
    ('public.products', 'products_update_admin'),
    ('public.product_images', 'product_images_select_public'),
    ('public.product_images', 'product_images_insert_admin'),
    ('public.product_images', 'product_images_update_admin'),
    ('public.product_images', 'product_images_delete_admin'),
    ('public.product_doses', 'product_doses_select_public'),
    ('public.product_doses', 'product_doses_insert_admin'),
    ('public.product_doses', 'product_doses_update_admin'),
    ('public.product_doses', 'product_doses_delete_admin'),
    ('public.ambassadors', 'ambassadors_select_owner_or_admin'),
    ('public.ambassadors', 'ambassadors_insert_admin'),
    ('public.ambassadors', 'ambassadors_update_admin'),
    ('public.partner_clicks', 'partner_clicks_select_owner_or_admin'),
    ('public.partner_clicks', 'partner_clicks_insert_any'),
    ('public.partner_payouts', 'partner_payouts_select_owner_or_admin'),
    ('public.partner_payouts', 'partner_payouts_insert_admin'),
    ('public.admin_audit_logs', 'admin_audit_logs_admin_only'),
    ('public.admin_audit_logs', 'admin_audit_logs_insert_admin'),
    ('public.admin_credentials', 'admin_credentials_admin_only'),
    ('public.admin_credentials', 'admin_credentials_admin_update'),
    ('public.admin_sessions', 'admin_sessions_admin_only'),
    ('public.admin_sessions', 'admin_sessions_admin_insert'),
    ('public.admin_sessions', 'admin_sessions_admin_delete'),
    ('public.admin_login_attempts', 'admin_login_attempts_admin_only'),
    ('public.admin_login_attempts', 'admin_login_attempts_admin_insert'),
    ('public.admin_login_attempts', 'admin_login_attempts_admin_delete'),
    ('public.inventory_items', 'inventory_items_admin_only'),
    ('public.order_shipments', 'order_shipments_admin_only'),
    ('public.coupons', 'coupons_admin_only'),
    ('public.notification_queue', 'notification_queue_admin_only'),
    ('public.website_analytics_events', 'website_analytics_events_insert_any'),
    ('public.website_analytics_events', 'website_analytics_events_select_admin')
  ) as t(table_name, policy_name)
)
select
  expected_policies.table_name,
  expected_policies.policy_name,
  case
    when to_regclass(expected_policies.table_name) is null then 'SKIPPED_TABLE_MISSING'
    when policies.policyname is not null then 'PASS'
    else 'MISSING'
  end as status
from expected_policies
left join pg_policies policies
  on policies.schemaname = split_part(expected_policies.table_name, '.', 1)
 and policies.tablename = split_part(expected_policies.table_name, '.', 2)
 and policies.policyname = expected_policies.policy_name
order by expected_policies.table_name, expected_policies.policy_name;

-- 6) Expected indexes should exist when their tables exist.
with expected_indexes as (
  select * from (values
    ('public.orders', 'idx_orders_created_at'),
    ('public.orders', 'idx_orders_payment_status'),
    ('public.orders', 'idx_orders_ambassador_id'),
    ('public.orders', 'idx_orders_referral_code'),
    ('public.orders', 'idx_orders_customer_email'),
    ('public.payment_events', 'idx_payment_events_order_id'),
    ('public.referral_orders', 'idx_referral_orders_ambassador_id'),
    ('public.referral_orders', 'idx_referral_orders_order_id'),
    ('public.referral_orders', 'idx_referral_orders_payment_status'),
    ('public.partners', 'idx_partners_status'),
    ('public.partners', 'idx_partners_auth_user_id'),
    ('public.partners', 'idx_partners_updated_at'),
    ('public.partners', 'idx_partners_referral_code'),
    ('public.referrals', 'idx_referrals_partner_id'),
    ('public.referrals', 'idx_referrals_order_id'),
    ('public.referrals', 'idx_referrals_event_type'),
    ('public.referrals', 'idx_referrals_created_at'),
    ('public.commissions', 'idx_commissions_partner_id'),
    ('public.commissions', 'idx_commissions_status'),
    ('public.payouts', 'idx_payouts_partner_id'),
    ('public.payouts', 'idx_payouts_created_at'),
    ('public.products', 'idx_products_slug'),
    ('public.products', 'idx_products_is_active'),
    ('public.products', 'idx_products_category'),
    ('public.products', 'idx_products_position'),
    ('public.products', 'idx_products_is_published'),
    ('public.products', 'idx_products_is_enabled'),
    ('public.products', 'idx_products_is_archived'),
    ('public.product_images', 'idx_product_images_product_id'),
    ('public.product_images', 'idx_product_images_position'),
    ('public.product_doses', 'idx_product_doses_product_id'),
    ('public.product_doses', 'idx_product_doses_position'),
    ('public.product_doses', 'idx_product_doses_product_slug_suffix'),
    ('public.ambassadors', 'idx_ambassadors_auth_user_id'),
    ('public.ambassadors', 'idx_ambassadors_referral_code'),
    ('public.ambassadors', 'idx_ambassadors_status'),
    ('public.ambassadors', 'idx_ambassadors_updated_at'),
    ('public.partner_clicks', 'idx_partner_clicks_ambassador_id'),
    ('public.partner_clicks', 'idx_partner_clicks_created_at'),
    ('public.partner_clicks', 'idx_partner_clicks_referral_code'),
    ('public.partner_payouts', 'idx_partner_payouts_ambassador_id'),
    ('public.partner_payouts', 'idx_partner_payouts_created_at'),
    ('public.admin_audit_logs', 'idx_admin_audit_logs_actor'),
    ('public.admin_audit_logs', 'idx_admin_audit_logs_created_at'),
    ('public.admin_credentials', 'idx_admin_credentials_username'),
    ('public.admin_sessions', 'idx_admin_sessions_token_hash'),
    ('public.admin_sessions', 'idx_admin_sessions_expires_at'),
    ('public.admin_login_attempts', 'idx_admin_login_attempts_username_attempted_at'),
    ('public.admin_login_attempts', 'idx_admin_login_attempts_ip_attempted_at'),
    ('public.order_shipments', 'idx_order_shipments_order_id'),
    ('public.notification_queue', 'idx_notification_queue_status'),
    ('public.website_analytics_events', 'idx_website_analytics_events_created_at'),
    ('public.website_analytics_events', 'idx_website_analytics_events_event_type'),
    ('public.website_analytics_events', 'idx_website_analytics_events_page_path'),
    ('public.website_analytics_events', 'idx_website_analytics_events_session_id')
  ) as t(table_name, index_name)
)
select
  expected_indexes.table_name,
  expected_indexes.index_name,
  case
    when to_regclass(expected_indexes.table_name) is null then 'SKIPPED_TABLE_MISSING'
    when indexclass.oid is not null then 'PASS'
    else 'MISSING'
  end as status
from expected_indexes
left join pg_class indexclass
  on indexclass.relkind = 'i'
 and indexclass.relname = expected_indexes.index_name
order by expected_indexes.table_name, expected_indexes.index_name;

-- 7) RLS should be enabled for tables that exist. Failures should be empty.
with tracked_tables as (
  select * from (values
    ('public.orders'),
    ('public.order_items'),
    ('public.payment_events'),
    ('public.referral_orders'),
    ('public.partners'),
    ('public.referrals'),
    ('public.commissions'),
    ('public.payouts'),
    ('public.partner_program_stats'),
    ('public.products'),
    ('public.product_images'),
    ('public.product_doses'),
    ('public.ambassadors'),
    ('public.partner_clicks'),
    ('public.partner_payouts'),
    ('public.admin_audit_logs'),
    ('public.admin_credentials'),
    ('public.admin_sessions'),
    ('public.admin_login_attempts'),
    ('public.inventory_items'),
    ('public.order_shipments'),
    ('public.coupons'),
    ('public.notification_queue'),
    ('public.website_analytics_events')
  ) as t(table_name)
)
select
  tracked_tables.table_name,
  case
    when to_regclass(tracked_tables.table_name) is null then 'SKIPPED_TABLE_MISSING'
    when tableinfo.rowsecurity then 'PASS'
    else 'RLS_DISABLED'
  end as status
from tracked_tables
left join pg_class tableinfo
  on tableinfo.oid = to_regclass(tracked_tables.table_name)
order by tracked_tables.table_name;

-- 8) Optional: inspect live advisor-like candidates that still have multiple
-- permissive SELECT policies on the same table. These are not always wrong,
-- but they are good review targets.
select
  schemaname,
  tablename,
  count(*) as permissive_select_policy_count,
  string_agg(policyname, ', ' order by policyname) as policies
from pg_policies
where schemaname = 'public'
  and cmd = 'SELECT'
group by schemaname, tablename
having count(*) > 1
order by tablename;