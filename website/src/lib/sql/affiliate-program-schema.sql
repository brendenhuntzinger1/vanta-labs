-- Canonical affiliate program tables
-- These are the primary tables for partner operations in Supabase.

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

create index if not exists idx_partners_status on public.partners(status);
create index if not exists idx_partners_auth_user_id on public.partners(auth_user_id);
create index if not exists idx_partners_updated_at on public.partners(updated_at desc);
create index if not exists idx_referrals_partner_id on public.referrals(partner_id);
create index if not exists idx_referrals_event_type on public.referrals(event_type);
create index if not exists idx_referrals_created_at on public.referrals(created_at desc);
create index if not exists idx_commissions_partner_id on public.commissions(partner_id);
create index if not exists idx_commissions_status on public.commissions(status);
create index if not exists idx_payouts_partner_id on public.payouts(partner_id);
create index if not exists idx_payouts_created_at on public.payouts(created_at desc);

alter table public.partners enable row level security;
alter table public.referrals enable row level security;
alter table public.commissions enable row level security;
alter table public.payouts enable row level security;
alter table public.partner_program_stats enable row level security;
