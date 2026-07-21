-- ============================================================================
-- ADMIN COLUMN SYNC
--
-- Adds the columns/constraints the admin dashboard needs that live in the
-- earlier per-feature migrations (shipping country, coupons, refunds, roles,
-- low-stock thresholds, shipment upserts). Bundled here so the whole admin
-- works after one run.
--
-- 100% idempotent and safe on ANY database state — every statement is
-- "add only if it isn't already there". Re-running it does nothing new.
-- Paste into Supabase → SQL Editor → Run.
-- ============================================================================

-- orders: country-aware shipping + handling fee
alter table if exists public.orders
  add column if not exists country text,
  add column if not exists handling_fee numeric(12,2) not null default 0;

-- orders: coupon tracking (which coupon an order used)
alter table if exists public.orders
  add column if not exists coupon_code text;
create index if not exists idx_orders_coupon_code
  on public.orders(coupon_code) where coupon_code is not null;

-- orders: partial refund tracking
alter table if exists public.orders
  add column if not exists refund_amount numeric(12,2) not null default 0,
  add column if not exists refunded_at timestamptz;

-- admin_credentials: role-based permissions (staff / manager / super_admin)
alter table if exists public.admin_credentials
  add column if not exists role text not null default 'staff';
alter table if exists public.admin_credentials
  drop constraint if exists admin_credentials_role_check;
alter table if exists public.admin_credentials
  add constraint admin_credentials_role_check
  check (role in ('staff', 'manager', 'super_admin'));
create index if not exists idx_admin_credentials_role
  on public.admin_credentials(role);

-- products + doses: per-line low-stock threshold for admin alerts
alter table if exists public.products
  add column if not exists low_stock_threshold integer not null default 5;
alter table if exists public.product_doses
  add column if not exists low_stock_threshold integer not null default 5;

-- order_shipments: unique constraint the admin shipment upsert needs.
-- Guarded so it only runs if the table exists and the constraint is missing.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_shipments'
  ) and not exists (
    select 1 from pg_constraint where conname = 'order_shipments_order_id_key'
  ) then
    alter table public.order_shipments
      add constraint order_shipments_order_id_key unique (order_id);
  end if;
end;
$$;

-- ============================================================================
-- Done. The admin Fulfillment, Orders, Inventory, Team, and Refund views
-- should now load without "column does not exist" errors.
-- ============================================================================
