-- =========================================================================
-- Profit engine v2 — actual-shipping-cost reconciliation + audit history.
--
-- Net profit is calculated from an ESTIMATED shipping cost the moment an order
-- is placed, then reconciled to the EXACT shipping-label cost once the order
-- ships (from the 3PL webhook, the fulfillment provider, or a manual admin
-- entry). At that point the order's profit flips from "Estimated" to
-- "Finalized". Historical orders retain the cost/fee snapshot that applied when
-- they were placed — future admin setting changes never silently rewrite a
-- finalized order.
--
-- Run after orders-schema.sql. Idempotent.
-- =========================================================================

-- Per-order shipping-cost reconciliation columns on the orders table.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'estimated_shipping_cost_cents') then
    alter table public.orders add column estimated_shipping_cost_cents integer;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'actual_shipping_cost_cents') then
    alter table public.orders add column actual_shipping_cost_cents integer;
  end if;
  -- Where the exact shipping cost came from: estimate | provider | fulfillment | manual
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'shipping_cost_source') then
    alter table public.orders add column shipping_cost_source text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'shipping_cost_updated_at') then
    alter table public.orders add column shipping_cost_updated_at timestamptz;
  end if;
  -- True once the exact shipping-label cost has been reconciled in.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'profit_finalized') then
    alter table public.orders add column profit_finalized boolean not null default false;
  end if;
end;
$$;

-- Append-only audit trail for every shipping-cost update (estimate → exact, and
-- any manual correction). Preserves the estimated cost, the exact cost, the
-- profit before/after, who changed it, and where the cost came from.
create table if not exists public.order_shipping_cost_audit (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete cascade,
  estimated_cost_cents integer,
  exact_cost_cents integer,
  difference_cents integer,                          -- exact − estimated
  source text not null default 'manual',             -- provider | fulfillment | manual
  previous_estimated_profit_cents integer,
  finalized_net_profit_cents integer,
  changed_by text,                                   -- admin username, or null for automated
  created_at timestamptz not null default now()
);

create index if not exists idx_order_shipping_cost_audit_order_id on public.order_shipping_cost_audit(order_id);
create index if not exists idx_order_shipping_cost_audit_created_at on public.order_shipping_cost_audit(created_at desc);

alter table public.order_shipping_cost_audit enable row level security;
-- Service-role only (admin/server), reached exclusively through supabaseAdmin.
-- No public policies.
