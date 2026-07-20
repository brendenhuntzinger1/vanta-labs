-- =========================================================================
-- 3PL / Fulfillment integration
--
-- Provider-agnostic tables that let any third-party logistics provider be
-- connected by entering API credentials in the admin dashboard. Paid + verified
-- orders are transmitted to the 3PL automatically; the 3PL reports status,
-- tracking, inventory, cancellations, refunds, and errors back via a webhook,
-- which updates these tables and the orders table in real time.
--
-- Run after orders-schema.sql and manual-payments.sql. Idempotent.
-- =========================================================================

-- One row per order handed to the 3PL. Mirrors the order into the fulfillment
-- domain and tracks the external provider's identifiers and status.
create table if not exists public.fulfillment_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique references public.orders(order_id) on delete cascade,
  order_number text,
  provider text not null default 'manual',        -- which 3PL adapter handled it
  external_id text,                                -- the 3PL's own order id
  -- queued | sent | accepted | processing | shipped | delivered | cancelled | error
  status text not null default 'queued',
  tracking_number text,
  tracking_url text,
  carrier text,
  last_error text,
  transmitted_at timestamptz,                      -- when we sent it to the 3PL
  last_synced_at timestamptz,                      -- last inbound update from the 3PL
  payload jsonb,                                   -- exact payload we transmitted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only event/audit log for every outbound transmission and inbound
-- webhook (status update, tracking, inventory sync, cancellation, refund,
-- error). Doubles as the API call log.
create table if not exists public.fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  order_id text,                                   -- null for non-order events (e.g. bulk inventory sync)
  provider text,
  direction text not null,                         -- outbound | inbound
  event_type text not null,                        -- e.g. order.created, status.updated, tracking.added, inventory.sync, order.cancelled, refund.created, error
  status_code integer,                             -- HTTP status for API calls
  ok boolean not null default true,
  message text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- 3PL payout records. Amount owed is computed from the configurable payout
-- model (fixed per vial, or a percentage of the order). One row per order (or
-- per settlement period) so payouts can be tracked and reconciled.
create table if not exists public.fulfillment_payouts (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique references public.orders(order_id) on delete cascade,
  order_number text,
  provider text,
  units integer not null default 0,               -- total vials/units in the order
  model text not null default 'per_unit',         -- per_unit | percent
  rate numeric(12,2) not null default 0,          -- $/unit or percent, as configured when recorded
  amount_owed numeric(12,2) not null default 0,
  -- pending | paid | failed
  status text not null default 'pending',
  paid_at timestamptz,
  reference text,                                  -- external settlement reference
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_fulfillment_orders_status on public.fulfillment_orders(status);
create index if not exists idx_fulfillment_orders_provider on public.fulfillment_orders(provider);
create index if not exists idx_fulfillment_events_order_id on public.fulfillment_events(order_id);
create index if not exists idx_fulfillment_events_created_at on public.fulfillment_events(created_at desc);
create index if not exists idx_fulfillment_payouts_status on public.fulfillment_payouts(status);

alter table public.fulfillment_orders enable row level security;
alter table public.fulfillment_events enable row level security;
alter table public.fulfillment_payouts enable row level security;

-- Service-role only (admin/server). No public policies — these are internal
-- operational tables, reached exclusively through the server (supabaseAdmin).
