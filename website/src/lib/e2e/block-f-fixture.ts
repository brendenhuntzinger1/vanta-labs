// ---------------------------------------------------------------------------
// The orders/order_items/commissions fixture the financial-reporting suites run
// against. Column list, types and defaults are taken verbatim from the
// production `public.orders` table (information_schema, read-only, 2026-08-26),
// trimmed to the columns the reporting modules actually select plus the ones
// the rollup SQL groups on. Types matter: `numeric(12,2)` rounds a seeded value
// the way production does, and `points_redeemed integer` is why the
// reconciliation reader divides it by 100.
// ---------------------------------------------------------------------------

export const ORDERS_DDL = `
create extension if not exists pgcrypto;

drop table if exists public.points_ledger cascade;
drop table if exists public.commissions cascade;
drop table if exists public.order_items cascade;
drop table if exists public.orders cascade;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  order_number text,
  customer_email text,
  customer_name text,
  state text,
  currency text not null default 'USD',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  handling_fee numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  tax_rate_percent numeric(6,3) not null default 0,
  tax_state text,
  card_processing_fee numeric(12,2) not null default 0,
  shipping_protection_fee numeric(12,2) not null default 0,
  store_credit_redeemed_cents integer not null default 0,
  points_redeemed integer not null default 0,
  amount_paid numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  payment_method text,
  payment_status text not null default 'pending_payment',
  fulfillment_status text not null default 'pending',
  order_type text not null default 'product',
  bulk_discount_tier text,
  actual_shipping_cost_cents integer,
  estimated_shipping_cost_cents integer,
  shipping_cost_source text,
  profit_finalized boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  product_id text,
  product_name text,
  quantity integer not null default 1,
  unit_price numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0,
  unit_cost_cents integer
);

create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  commission_amount numeric(12,2) not null default 0,
  payment_status text not null default 'pending'
);

-- Only so admin-dashboard-rollups.sql compiles unedited; not exercised here.
create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  amount integer not null default 0
);

create index idx_orders_created_at on public.orders(created_at desc);
create index idx_orders_payment_status on public.orders(payment_status);
create index idx_orders_order_type on public.orders(order_type);
`;

/**
 * The rollup SQL grants EXECUTE to `service_role`, which only exists on a
 * Supabase instance. Created here so the real migration file can be applied
 * verbatim rather than edited for the test — an edited migration proves nothing
 * about the one that runs in production.
 */
export const SERVICE_ROLE_DDL = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end
$$;
`;

export interface SeedOrder {
  orderId: string;
  orderNumber?: string;
  customerEmail?: string;
  state?: string | null;
  taxState?: string | null;
  subtotal?: number;
  shipping?: number;
  discount?: number;
  handlingFee?: number;
  tax?: number;
  taxRatePercent?: number;
  cardFee?: number;
  protectionFee?: number;
  storeCreditCents?: number;
  pointsRedeemed?: number;
  amountPaid?: number;
  refundAmount?: number;
  paymentMethod?: string;
  paymentStatus?: string;
  orderType?: string;
  paidAt?: string | null;
  createdAt?: string;
  unitCostCents?: number | null;
  quantity?: number;
  commissionAmount?: number;
  commissionStatus?: string;
}

/** Builds the INSERT for one order (+ its single item, + its commission row). */
export function seedOrderSql(order: SeedOrder): { text: string; values: unknown[] } {
  const values = [
    order.orderId,
    order.orderNumber ?? order.orderId.toUpperCase(),
    order.customerEmail ?? `${order.orderId}@example.test`,
    order.state ?? null,
    order.taxState ?? null,
    order.subtotal ?? 0,
    order.shipping ?? 0,
    order.discount ?? 0,
    order.handlingFee ?? 0,
    order.tax ?? 0,
    order.taxRatePercent ?? 0,
    order.cardFee ?? 0,
    order.protectionFee ?? 0,
    order.storeCreditCents ?? 0,
    order.pointsRedeemed ?? 0,
    order.amountPaid ?? 0,
    order.refundAmount ?? 0,
    order.paymentMethod ?? "card",
    order.paymentStatus ?? "paid",
    order.orderType ?? "product",
    order.paidAt === undefined ? order.createdAt ?? new Date().toISOString() : order.paidAt,
    order.createdAt ?? new Date().toISOString(),
  ];
  return {
    text: `insert into public.orders (
      order_id, order_number, customer_email, state, tax_state,
      subtotal, shipping_amount, discount_amount, handling_fee, tax_amount, tax_rate_percent,
      card_processing_fee, shipping_protection_fee, store_credit_redeemed_cents, points_redeemed,
      amount_paid, refund_amount, payment_method, payment_status, order_type, paid_at, created_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    values,
  };
}
