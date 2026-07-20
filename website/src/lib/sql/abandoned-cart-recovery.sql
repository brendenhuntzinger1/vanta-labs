-- Abandoned cart recovery system.
--
-- Reuses email_suppressions / email_send_log from membership-billing.sql
-- for consent + delivery tracking rather than duplicating them - run this
-- file after membership-billing.sql.
--
-- Idempotent - safe to re-run.

create table if not exists public.abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  customer_user_id uuid references auth.users(id) on delete set null,
  email text not null,
  customer_name text,
  items jsonb not null default '[]'::jsonb, -- snapshot: [{slug, variantId, name, quantity, unitPrice, image}]
  cart_value_cents integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  status text not null default 'active', -- active | recovered | expired
  recovered_order_id text references public.orders(order_id) on delete set null,
  created_at timestamptz not null default now()
);

-- One active row per session - repeated cart-change pings from the same
-- browser session update the same row instead of creating duplicates.
create unique index if not exists idx_abandoned_carts_session_active
  on public.abandoned_carts(session_id)
  where status = 'active';

create index if not exists idx_abandoned_carts_email on public.abandoned_carts(email);
create index if not exists idx_abandoned_carts_status on public.abandoned_carts(status, first_seen_at);
create index if not exists idx_abandoned_carts_recovered_order on public.abandoned_carts(recovered_order_id) where recovered_order_id is not null;

create table if not exists public.abandoned_cart_emails (
  id uuid primary key default gen_random_uuid(),
  abandoned_cart_id uuid not null references public.abandoned_carts(id) on delete cascade,
  stage text not null, -- t30m | t12h | t24h | t72h
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  clicked_at timestamptz,
  coupon_id uuid references public.coupons(id) on delete set null
);

-- One send per stage per cart - the sweep checks this before sending so a
-- coarser cron interval never double-sends a stage.
create unique index if not exists idx_abandoned_cart_emails_cart_stage
  on public.abandoned_cart_emails(abandoned_cart_id, stage);

alter table public.abandoned_carts enable row level security;
alter table public.abandoned_cart_emails enable row level security;

-- No anon/authenticated policies - written and read only by server code
-- (src/lib/cart-recovery.ts, the admin cart-recovery dashboard) using the
-- service-role client, same reasoning as membership_billing_events.
