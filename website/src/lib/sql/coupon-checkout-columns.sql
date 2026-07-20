-- Phase 4 admin dashboard: real coupon system.
--
-- public.coupons already exists (partner-portal-schema.sql) but nothing in
-- the app reads it yet. This adds the order-side column needed to record
-- which coupon (if any) an order used, for redemption counting (see
-- src/lib/coupons.ts) and the admin orders view.
--
-- Run after partner-portal-schema.sql and admin-rbac-refunds.sql. Idempotent.

alter table if exists public.orders
  add column if not exists coupon_code text;

create index if not exists idx_orders_coupon_code on public.orders(coupon_code) where coupon_code is not null;
