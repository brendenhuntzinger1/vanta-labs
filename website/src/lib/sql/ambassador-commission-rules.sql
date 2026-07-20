-- Ambassador commission rules: performance tiers, minimum qualifying order,
-- minimum payout threshold, self-referral prevention, and fraud review flags.
--
-- Program-wide settings (minimum qualifying order, minimum payout threshold,
-- commission hold days) are NOT stored here - they live in the existing
-- admin_control KV mechanism (admin_audit_logs action=admin_control_upsert,
-- section "ambassador"), the same pattern src/lib/admin-control.ts already
-- uses for homepage/promotions/membership settings. See
-- src/lib/ambassador-settings.ts.
--
-- Run after partner-system-repair.sql. Idempotent.

create table if not exists public.commission_tier_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  min_monthly_sales integer not null default 0,
  commission_percent numeric(5,2) not null,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.commission_tier_rules (name, min_monthly_sales, commission_percent, position)
select 'Starter', 0, 10, 0
where not exists (select 1 from public.commission_tier_rules where name = 'Starter');

insert into public.commission_tier_rules (name, min_monthly_sales, commission_percent, position)
select 'Growth', 20, 12.5, 1
where not exists (select 1 from public.commission_tier_rules where name = 'Growth');

insert into public.commission_tier_rules (name, min_monthly_sales, commission_percent, position)
select 'Elite', 50, 15, 2
where not exists (select 1 from public.commission_tier_rules where name = 'Elite');

create index if not exists idx_commission_tier_rules_min_sales on public.commission_tier_rules(min_monthly_sales);

-- commission_percent on partners/ambassadors is kept as a manual override.
-- When commission_percent_locked is true, that override is used as-is;
-- when false (the default), the effective commission percent is computed
-- automatically from commission_tier_rules based on the ambassador's
-- qualifying paid, non-refunded order count in the current calendar month.
alter table if exists public.partners
  add column if not exists commission_percent_locked boolean not null default false;

alter table if exists public.ambassadors
  add column if not exists commission_percent_locked boolean not null default false;

-- Records why a paid order's referral commission didn't qualify (order
-- below the minimum qualifying order amount) or was flagged for fraud
-- review (repeat address/email abuse under the same referral code). These
-- are informational - they never block the sale itself, only whether it
-- earns the ambassador a commission.
alter table if exists public.referral_orders
  add column if not exists tier_name text,
  add column if not exists ineligible_reason text,
  add column if not exists fraud_flag boolean not null default false,
  add column if not exists fraud_reason text;

alter table if exists public.commissions
  add column if not exists tier_name text,
  add column if not exists ineligible_reason text,
  add column if not exists fraud_flag boolean not null default false,
  add column if not exists fraud_reason text;

create index if not exists idx_referral_orders_fraud_flag on public.referral_orders(fraud_flag) where fraud_flag = true;

alter table public.commission_tier_rules enable row level security;

drop policy if exists commission_tier_rules_read_all on public.commission_tier_rules;
create policy commission_tier_rules_read_all on public.commission_tier_rules
for select
using (true);

-- All writes to commission_tier_rules go through server API routes using
-- the service-role client - no anon/authenticated write policy is defined
-- here, matching the membership_tiers precedent in membership-rewards.sql.
