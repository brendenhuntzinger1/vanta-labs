-- Growth features: back-in-stock notifications + subscribe-and-save.
--
-- Run after orders-schema.sql. Idempotent.

-- "Notify me when back in stock" requests. When a product is restocked, the
-- pending requests for it are emailed and marked notified.
create table if not exists public.back_in_stock_requests (
  id uuid primary key default gen_random_uuid(),
  product_slug text not null,
  variant_id text,
  email text not null,
  notified boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

-- One pending request per email+product+variant (upsert target).
create unique index if not exists idx_bis_unique_pending
  on public.back_in_stock_requests(product_slug, coalesce(variant_id, ''), email)
  where notified = false;
create index if not exists idx_bis_product on public.back_in_stock_requests(product_slug) where notified = false;

-- Subscribe-and-save intents. Recorded when a customer opts into a recurring
-- order. status stays 'pending' until a recurring payment processor is
-- connected, at which point these activate and begin billing — so the feature
-- is "built in" and dormant, never charging without a processor.
create table if not exists public.product_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  product_slug text not null,
  variant_id text,
  frequency_days integer not null default 30,
  discount_percent numeric(5,2) not null default 0,
  -- pending | active | paused | canceled
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_subscriptions_user on public.product_subscriptions(user_id);
create index if not exists idx_product_subscriptions_status on public.product_subscriptions(status);

alter table public.back_in_stock_requests enable row level security;
alter table public.product_subscriptions enable row level security;
-- Service-role only (server-side). No public policies.
