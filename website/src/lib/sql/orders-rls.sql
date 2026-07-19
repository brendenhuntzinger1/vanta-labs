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

drop policy if exists orders_select_admin on public.orders;
create policy orders_select_admin on public.orders
for select
using ((select public.current_auth_role()) = 'admin');

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
create policy referral_orders_select_admin on public.referral_orders
for select
using ((select public.current_auth_role()) = 'admin');

drop policy if exists referral_orders_insert_admin on public.referral_orders;
create policy referral_orders_insert_admin on public.referral_orders
for insert
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists referral_orders_update_admin on public.referral_orders;
create policy referral_orders_update_admin on public.referral_orders
for update
using ((select public.current_auth_role()) = 'admin');
