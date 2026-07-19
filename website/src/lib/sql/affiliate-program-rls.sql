-- RLS policies for canonical affiliate tables

create policy if not exists partners_select_owner_or_admin on public.partners
for select
using (auth.uid() = auth_user_id or auth.jwt() ->> 'role' = 'admin');

create policy if not exists partners_insert_admin on public.partners
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists partners_update_admin on public.partners
for update
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists referrals_select_owner_or_admin on public.referrals
for select
using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists referrals_insert_any on public.referrals
for insert
with check (true);

create policy if not exists commissions_select_owner_or_admin on public.commissions
for select
using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists commissions_insert_admin on public.commissions
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists commissions_update_admin on public.commissions
for update
using (auth.jwt() ->> 'role' = 'admin');

create policy if not exists payouts_select_owner_or_admin on public.payouts
for select
using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

create policy if not exists payouts_insert_admin on public.payouts
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists partner_program_stats_select_public on public.partner_program_stats
for select
using (true);

create policy if not exists partner_program_stats_insert_admin on public.partner_program_stats
for insert
with check (auth.jwt() ->> 'role' = 'admin');

create policy if not exists partner_program_stats_update_admin on public.partner_program_stats
for update
using (auth.jwt() ->> 'role' = 'admin');
