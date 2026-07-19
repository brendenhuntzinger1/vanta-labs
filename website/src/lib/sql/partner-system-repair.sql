-- Partner system repair migration
-- Safe to run repeatedly.

-- Canonical affiliate tables
create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  name text not null,
  email text,
  referral_code text not null unique,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  referral_code text not null,
  event_type text not null default 'click',
  order_id text,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  order_id text not null unique,
  referral_code text,
  commission_percent numeric(5,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  amount numeric(12,2) not null,
  note text,
  processed_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.partner_program_stats (
  key text primary key,
  value_numeric numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Compatibility / existing tables used by current app
create table if not exists public.ambassadors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  referral_code text not null unique,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  auth_user_id uuid,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.partner_clicks (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null,
  referral_code text not null,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create table if not exists public.partner_payouts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null,
  amount numeric(12,2) not null,
  note text,
  processed_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  target_table text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ensure required columns exist for legacy table shapes
alter table if exists public.partners
  add column if not exists auth_user_id uuid,
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists referral_code text,
  add column if not exists status text not null default 'pending',
  add column if not exists commission_percent numeric(5,2) not null default 10,
  add column if not exists invited_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.ambassadors
  add column if not exists auth_user_id uuid,
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists referral_code text,
  add column if not exists status text not null default 'pending',
  add column if not exists commission_percent numeric(5,2) not null default 10,
  add column if not exists invited_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Create core order tables if this is a fresh database
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  payment_id text,
  customer_email text,
  customer_name text,
  shipping_address text,
  city text,
  postal_code text,
  currency text not null default 'USD',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  referral_code text,
  ambassador_id uuid,
  payment_status text not null default 'pending_payment',
  fulfillment_status text not null default 'pending',
  tracking_number text,
  paid_at timestamptz,
  provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete cascade,
  product_id text,
  product_name text,
  unit_price numeric(12,2) not null default 0,
  quantity integer not null default 0,
  line_total numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_events (
  event_id text primary key,
  order_id text not null,
  status text not null,
  processed_at timestamptz not null default now()
);

-- Ensure required columns exist
alter table if exists public.orders
  add column if not exists referral_code text,
  add column if not exists ambassador_id uuid,
  add column if not exists payment_status text not null default 'pending_payment',
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.referral_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  ambassador_id uuid,
  referral_code text,
  commission_percent numeric(5,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  payment_id text,
  payment_status text not null default 'pending',
  provider_event_id text,
  review_required boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.referral_orders
  add column if not exists ambassador_id uuid,
  add column if not exists referral_code text,
  add column if not exists commission_percent numeric(5,2) not null default 0,
  add column if not exists commission_amount numeric(12,2) not null default 0,
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists payment_id text,
  add column if not exists payment_status text not null default 'pending',
  add column if not exists provider_event_id text,
  add column if not exists review_required boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Indexes
create index if not exists idx_partners_status on public.partners(status);
create index if not exists idx_partners_auth_user_id on public.partners(auth_user_id);
create index if not exists idx_partners_referral_code on public.partners(referral_code);
create index if not exists idx_referrals_partner_id on public.referrals(partner_id);
create index if not exists idx_referrals_order_id on public.referrals(order_id);
create index if not exists idx_commissions_partner_id on public.commissions(partner_id);
create index if not exists idx_commissions_status on public.commissions(status);
create index if not exists idx_payouts_partner_id on public.payouts(partner_id);
create index if not exists idx_ambassadors_referral_code on public.ambassadors(referral_code);
create index if not exists idx_ambassadors_auth_user_id on public.ambassadors(auth_user_id);
create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id);
create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id);
create index if not exists idx_referral_orders_ambassador_id on public.referral_orders(ambassador_id);
create index if not exists idx_referral_orders_order_id on public.referral_orders(order_id);
create index if not exists idx_orders_ambassador_id on public.orders(ambassador_id);
create index if not exists idx_orders_referral_code on public.orders(referral_code);

-- RLS enablement
alter table public.partners enable row level security;
alter table public.referrals enable row level security;
alter table public.commissions enable row level security;
alter table public.payouts enable row level security;
alter table public.partner_program_stats enable row level security;
alter table public.ambassadors enable row level security;
alter table public.partner_clicks enable row level security;
alter table public.partner_payouts enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.referral_orders enable row level security;

-- Core policies for canonical tables
drop policy if exists partners_select_owner_or_admin on public.partners;
create policy partners_select_owner_or_admin on public.partners
for select using (auth.uid() = auth_user_id or auth.jwt() ->> 'role' = 'admin');

drop policy if exists partners_insert_admin on public.partners;
create policy partners_insert_admin on public.partners
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partners_update_admin on public.partners;
create policy partners_update_admin on public.partners
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referrals_select_owner_or_admin on public.referrals;
create policy referrals_select_owner_or_admin on public.referrals
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists referrals_insert_any on public.referrals;
create policy referrals_insert_any on public.referrals
for insert with check (true);

drop policy if exists commissions_select_owner_or_admin on public.commissions;
create policy commissions_select_owner_or_admin on public.commissions
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists commissions_insert_admin on public.commissions;
create policy commissions_insert_admin on public.commissions
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists commissions_update_admin on public.commissions;
create policy commissions_update_admin on public.commissions
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists payouts_select_owner_or_admin on public.payouts;
create policy payouts_select_owner_or_admin on public.payouts
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists payouts_insert_admin on public.payouts;
create policy payouts_insert_admin on public.payouts
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_program_stats_select_public on public.partner_program_stats;
create policy partner_program_stats_select_public on public.partner_program_stats
for select using (true);

drop policy if exists partner_program_stats_insert_admin on public.partner_program_stats;
create policy partner_program_stats_insert_admin on public.partner_program_stats
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_program_stats_update_admin on public.partner_program_stats;
create policy partner_program_stats_update_admin on public.partner_program_stats
for update using (auth.jwt() ->> 'role' = 'admin');

-- Keep legacy mirrors readable/writable for admin workflows
drop policy if exists ambassadors_select_owner_or_admin on public.ambassadors;
create policy ambassadors_select_owner_or_admin on public.ambassadors
for select using (auth.uid() = auth_user_id or auth.jwt() ->> 'role' = 'admin');

drop policy if exists ambassadors_insert_admin on public.ambassadors;
create policy ambassadors_insert_admin on public.ambassadors
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists ambassadors_update_admin on public.ambassadors;
create policy ambassadors_update_admin on public.ambassadors
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_clicks_select_owner_or_admin on public.partner_clicks;
create policy partner_clicks_select_owner_or_admin on public.partner_clicks
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists partner_clicks_insert_any on public.partner_clicks;
create policy partner_clicks_insert_any on public.partner_clicks
for insert with check (true);

drop policy if exists partner_payouts_select_owner_or_admin on public.partner_payouts;
create policy partner_payouts_select_owner_or_admin on public.partner_payouts
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists partner_payouts_insert_admin on public.partner_payouts;
create policy partner_payouts_insert_admin on public.partner_payouts
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_audit_logs_admin_only on public.admin_audit_logs;
create policy admin_audit_logs_admin_only on public.admin_audit_logs
for select using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_audit_logs_insert_admin on public.admin_audit_logs;
create policy admin_audit_logs_insert_admin on public.admin_audit_logs
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referral_orders_select_owner_or_admin on public.referral_orders;
create policy referral_orders_select_owner_or_admin on public.referral_orders
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists referral_orders_insert_admin on public.referral_orders;
create policy referral_orders_insert_admin on public.referral_orders
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referral_orders_update_admin on public.referral_orders;
create policy referral_orders_update_admin on public.referral_orders
for update using (auth.jwt() ->> 'role' = 'admin');
