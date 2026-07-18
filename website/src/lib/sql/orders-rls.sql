create policy if not exists orders_select_admin on public.orders
for select
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists orders_insert_admin on public.orders
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists orders_update_admin on public.orders
for update
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists order_items_select_admin on public.order_items
for select
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists order_items_insert_admin on public.order_items
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists order_items_update_admin on public.order_items
for update
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists payment_events_select_admin on public.payment_events
for select
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists payment_events_insert_admin on public.payment_events
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists referral_orders_select_admin on public.referral_orders
for select
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists referral_orders_insert_admin on public.referral_orders
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists referral_orders_update_admin on public.referral_orders
for update
using (auth.jwt() ->> 'role' = 'admin');
