-- Partner portal RLS policies

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

drop policy if exists ambassadors_select_owner on public.ambassadors;
create policy ambassadors_select_owner on public.ambassadors
for select
using (
  auth_user_id = (select public.current_auth_uid())
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists ambassadors_update_admin on public.ambassadors;
create policy ambassadors_update_admin on public.ambassadors
for update
using ((select public.current_auth_role()) = 'admin');

drop policy if exists ambassadors_insert_admin on public.ambassadors;
create policy ambassadors_insert_admin on public.ambassadors
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists partner_clicks_select_owner on public.partner_clicks;
create policy partner_clicks_select_owner on public.partner_clicks
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists partner_clicks_insert_any on public.partner_clicks;
create policy partner_clicks_insert_any on public.partner_clicks
for insert
with check (true);

drop policy if exists partner_payouts_select_owner on public.partner_payouts;
create policy partner_payouts_select_owner on public.partner_payouts
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists partner_payouts_insert_admin on public.partner_payouts;
create policy partner_payouts_insert_admin on public.partner_payouts
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists admin_audit_logs_admin_only on public.admin_audit_logs;
create policy admin_audit_logs_admin_only on public.admin_audit_logs
for select
using ((select public.current_auth_role()) = 'admin');

drop policy if exists admin_audit_logs_insert_admin on public.admin_audit_logs;
create policy admin_audit_logs_insert_admin on public.admin_audit_logs
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists inventory_items_admin_only on public.inventory_items;
create policy inventory_items_admin_only on public.inventory_items
for all
using ((select public.current_auth_role()) = 'admin')
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists order_shipments_admin_only on public.order_shipments;
create policy order_shipments_admin_only on public.order_shipments
for all
using ((select public.current_auth_role()) = 'admin')
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists coupons_admin_only on public.coupons;
create policy coupons_admin_only on public.coupons
for all
using ((select public.current_auth_role()) = 'admin')
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists notification_queue_admin_only on public.notification_queue;
create policy notification_queue_admin_only on public.notification_queue
for all
using ((select public.current_auth_role()) = 'admin')
with check ((select public.current_auth_role()) = 'admin');

-- Extend existing order/referral visibility to partners
drop policy if exists orders_select_partner on public.orders;
drop policy if exists orders_select_admin on public.orders;
drop policy if exists orders_select_owner_or_admin on public.orders;
create policy orders_select_owner_or_admin on public.orders
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);

drop policy if exists referral_orders_select_partner on public.referral_orders;
drop policy if exists referral_orders_select_admin on public.referral_orders;
drop policy if exists referral_orders_select_owner_or_admin on public.referral_orders;
create policy referral_orders_select_owner_or_admin on public.referral_orders
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = (select public.current_auth_uid())
  )
  or (select public.current_auth_role()) = 'admin'
);
