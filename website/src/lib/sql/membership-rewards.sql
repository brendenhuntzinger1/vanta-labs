-- Membership & Rewards program.
--
-- IMPORTANT: no payment processor is connected yet (see
-- src/lib/payment-provider.ts - PaymentProvider.refundPayment() etc. are
-- still stubs). Research Plus / Elite Research are billed nowhere today;
-- customer_memberships.status is set directly by the customer (free tier)
-- or by an admin (paid tiers, until real recurring billing exists). Do not
-- assume a "active" paid membership here means a card is actually being
-- charged.
--
-- Run after customer-accounts.sql. Idempotent.

create table if not exists public.membership_tiers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  monthly_price_cents integer not null default 0,
  annual_price_cents integer not null default 0,
  points_per_dollar numeric(6,2) not null default 1,
  free_shipping boolean not null default false,
  priority_shipping boolean not null default false,
  early_access boolean not null default false,
  exclusive_pricing boolean not null default false,
  referral_bonus_points integer not null default 0,
  benefits jsonb not null default '[]'::jsonb,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.membership_tiers (slug, name, monthly_price_cents, annual_price_cents, points_per_dollar, free_shipping, priority_shipping, early_access, exclusive_pricing, referral_bonus_points, benefits, position)
values
  ('free', 'Research Member', 0, 0, 2, false, false, false, false, 100,
   '["Earn 2 points per $1", "Member-only promotions", "Order history dashboard", "Reward points"]'::jsonb, 0),
  ('plus', 'Research Plus', 999, 9999, 3, true, false, true, false, 150,
   '["Earn 3 points per $1", "Free standard shipping", "Early access to new products", "Exclusive promotions"]'::jsonb, 1),
  ('elite', 'Elite Research', 1999, 19999, 5, true, true, true, true, 250,
   '["Earn 5 points per $1", "Free priority shipping", "Early access to launches", "Exclusive member pricing", "Higher referral rewards"]'::jsonb, 2)
on conflict (slug) do nothing;

create table if not exists public.customer_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier_id uuid not null references public.membership_tiers(id),
  billing_cycle text not null default 'monthly',
  status text not null default 'active',
  started_at timestamptz not null default now(),
  renews_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customer_memberships_tier_id on public.customer_memberships(tier_id);

create table if not exists public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  reason text not null,
  order_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_points_ledger_user_id on public.points_ledger(user_id, created_at desc);
create index if not exists idx_points_ledger_order_id on public.points_ledger(order_id) where order_id is not null;

create table if not exists public.promotional_point_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  multiplier numeric(6,2) not null default 2,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.customer_preferences
  add column if not exists birthday date,
  add column if not exists birthday_bonus_year integer,
  add column if not exists referral_code text unique,
  add column if not exists referred_by_code text;

-- points_redeemed is set at checkout (like coupon_code/discount_amount) so
-- the total shown to the shopper matches what payment-webhook.ts confirms;
-- points_earned is filled in once the order is confirmed paid, so refunds
-- know exactly how many points to claw back for that order. customer_user_id
-- links an order to the signed-in customer who placed it (null for guest
-- checkout) so points can be credited/reversed by a direct id lookup
-- instead of matching emails against the paginated auth admin API.
alter table if exists public.orders
  add column if not exists points_redeemed integer not null default 0,
  add column if not exists points_earned integer not null default 0,
  add column if not exists customer_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_orders_customer_user_id on public.orders(customer_user_id) where customer_user_id is not null;

alter table public.membership_tiers enable row level security;
alter table public.customer_memberships enable row level security;
alter table public.points_ledger enable row level security;
alter table public.promotional_point_events enable row level security;

drop policy if exists membership_tiers_read_all on public.membership_tiers;
create policy membership_tiers_read_all on public.membership_tiers
for select
using (true);

drop policy if exists membership_tiers_admin_write on public.membership_tiers;
create policy membership_tiers_admin_write on public.membership_tiers
for all
using ((select public.current_auth_role()) = 'admin')
with check ((select public.current_auth_role()) = 'admin');

drop policy if exists customer_memberships_select_own on public.customer_memberships;
create policy customer_memberships_select_own on public.customer_memberships
for select
using (user_id = (select public.current_auth_uid()));

drop policy if exists points_ledger_select_own on public.points_ledger;
create policy points_ledger_select_own on public.points_ledger
for select
using (user_id = (select public.current_auth_uid()));

drop policy if exists promotional_point_events_read_all on public.promotional_point_events;
create policy promotional_point_events_read_all on public.promotional_point_events
for select
using (true);

-- All writes to customer_memberships / points_ledger go through server API
-- routes using the service-role client (src/lib/membership.ts,
-- src/lib/admin-membership.ts) - there are intentionally no anon/customer
-- write policies here, since point balances must never be forgeable by a
-- client-side call.
