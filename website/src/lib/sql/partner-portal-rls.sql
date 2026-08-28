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

-- ONE NAME PER POLICY, ACROSS BOTH FILES THAT DEFINE IT.
--
-- These three SELECT policies were also created by partner-system-repair.sql,
-- under the `_select_owner_or_admin` names, with character-identical predicates
-- and no drop of the sibling. So production carried BOTH copies of each: two
-- PERMISSIVE policies OR-ing to exactly the same row set. Harmless in effect,
-- but it means the answer to "who can read this table" is spread over two files
-- that neither reference nor drop each other, and re-running either one put the
-- duplicate back — which is how the pair survived two advisor migrations that
-- had already dropped it.
--
-- Renamed to match partner-system-repair.sql rather than deleted from here:
-- this file is step 3 of DATABASE.md's setup order and step 6 of
-- README-partner-portal.md, and a fresh environment that runs it WITHOUT
-- partner-system-repair.sql would otherwise be left with no SELECT policy at
-- all — RLS on, nothing permitted, and an ambassador unable to read their own
-- row. The predicates below are unchanged, so this is a rename, not a grant.
-- The drop of the old name is what actually clears the duplicate.
drop policy if exists ambassadors_select_owner on public.ambassadors;
drop policy if exists ambassadors_select_owner_or_admin on public.ambassadors;
create policy ambassadors_select_owner_or_admin on public.ambassadors
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

-- Same duplicate pair as ambassadors above; see the note there.
drop policy if exists partner_clicks_select_owner on public.partner_clicks;
drop policy if exists partner_clicks_select_owner_or_admin on public.partner_clicks;
create policy partner_clicks_select_owner_or_admin on public.partner_clicks
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

-- Same duplicate pair as ambassadors above; see the note there.
drop policy if exists partner_payouts_select_owner on public.partner_payouts;
drop policy if exists partner_payouts_select_owner_or_admin on public.partner_payouts;
create policy partner_payouts_select_owner_or_admin on public.partner_payouts
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
