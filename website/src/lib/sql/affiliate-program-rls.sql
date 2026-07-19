-- RLS policies for canonical affiliate tables

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

drop policy if exists partners_select_owner_or_admin on public.partners;
create policy partners_select_owner_or_admin on public.partners
for select
using (auth_user_id = (select public.current_auth_uid()) or (select public.current_auth_role()) = 'admin');

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
  partner_id in (select id from public.partners where auth_user_id = (select public.current_auth_uid()))
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
  partner_id in (select id from public.partners where auth_user_id = (select public.current_auth_uid()))
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
  partner_id in (select id from public.partners where auth_user_id = (select public.current_auth_uid()))
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
