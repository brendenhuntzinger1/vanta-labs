-- Partner portal + affiliate operations schema
-- Run this after orders-schema.sql

alter table if exists public.ambassadors
  add column if not exists email text,
  add column if not exists auth_user_id uuid,
  add column if not exists invited_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_ambassadors_auth_user_id on public.ambassadors(auth_user_id);
create index if not exists idx_ambassadors_status on public.ambassadors(status);
create index if not exists idx_ambassadors_updated_at on public.ambassadors(updated_at desc);

create table if not exists public.partner_clicks (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete cascade,
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

create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id);
create index if not exists idx_partner_clicks_created_at on public.partner_clicks(created_at desc);
create index if not exists idx_partner_clicks_referral_code on public.partner_clicks(referral_code);

create table if not exists public.partner_payouts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete cascade,
  amount numeric(12,2) not null,
  note text,
  processed_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id);
create index if not exists idx_partner_payouts_created_at on public.partner_payouts(created_at desc);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  target_table text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_logs_actor on public.admin_audit_logs(actor_user_id);
create index if not exists idx_admin_audit_logs_created_at on public.admin_audit_logs(created_at desc);

-- Optional analytics and commerce management baseline
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  product_id text not null unique,
  sku text,
  quantity_on_hand integer not null default 0,
  reorder_level integer not null default 0,
  status text not null default 'active',
  updated_at timestamptz not null default now()
);

create table if not exists public.order_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete cascade,
  carrier text,
  tracking_number text,
  shipping_status text not null default 'pending',
  estimated_delivery timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_order_shipments_order_id on public.order_shipments(order_id);

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null default 'percent',
  discount_value numeric(12,2) not null,
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer,
  redemptions_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notification_queue_status on public.notification_queue(status, created_at);

alter table public.partner_clicks enable row level security;
alter table public.partner_payouts enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.inventory_items enable row level security;
alter table public.order_shipments enable row level security;
alter table public.coupons enable row level security;
alter table public.notification_queue enable row level security;
