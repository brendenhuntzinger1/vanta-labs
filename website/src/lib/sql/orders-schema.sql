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

create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_payment_status on public.orders(payment_status);
create index if not exists idx_orders_ambassador_id on public.orders(ambassador_id);
create index if not exists idx_orders_referral_code on public.orders(referral_code);
create index if not exists idx_orders_customer_email on public.orders(customer_email);
create index if not exists idx_payment_events_order_id on public.payment_events(order_id);
create index if not exists idx_referral_orders_ambassador_id on public.referral_orders(ambassador_id);
create index if not exists idx_referral_orders_payment_status on public.referral_orders(payment_status);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_events enable row level security;
alter table public.referral_orders enable row level security;
