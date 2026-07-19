-- Partner portal RLS policies

create policy if not exists ambassadors_select_owner on public.ambassadors
for select
using (
  auth.uid() = auth_user_id
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists ambassadors_update_admin on public.ambassadors
for update
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists ambassadors_insert_admin on public.ambassadors
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists partner_clicks_select_owner on public.partner_clicks
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = auth.uid()
  )
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists partner_clicks_insert_any on public.partner_clicks
for insert
with check (true);

create policy if not exists partner_payouts_select_owner on public.partner_payouts
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = auth.uid()
  )
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists partner_payouts_insert_admin on public.partner_payouts
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists admin_audit_logs_admin_only on public.admin_audit_logs
for select
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists admin_audit_logs_insert_admin on public.admin_audit_logs
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists inventory_items_admin_only on public.inventory_items
for all
using (auth.jwt() ->> 'role' = 'admin')
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists order_shipments_admin_only on public.order_shipments
for all
using (auth.jwt() ->> 'role' = 'admin')
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists coupons_admin_only on public.coupons
for all
using (auth.jwt() ->> 'role' = 'admin')
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists notification_queue_admin_only on public.notification_queue
for all
using (auth.jwt() ->> 'role' = 'admin')
with check (auth.jwt() ->> 'role' = 'admin');

-- Extend existing order/referral visibility to partners
create policy if not exists orders_select_partner on public.orders
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = auth.uid()
  )
);

create policy if not exists referral_orders_select_partner on public.referral_orders
for select
using (
  ambassador_id in (
    select id from public.ambassadors where auth_user_id = auth.uid()
  )
);
