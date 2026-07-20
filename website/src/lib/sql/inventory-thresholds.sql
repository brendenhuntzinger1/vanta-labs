-- Phase 4 admin dashboard: inventory management + low-stock alerts.
--
-- Inventory quantity already lives on public.products.inventory_quantity
-- and public.product_doses.inventory_quantity (the real source of truth
-- used by the storefront) - this only adds a per-line reorder threshold so
-- the admin inventory view can flag "low stock" before a line hits zero.
-- public.inventory_items (partner-portal-schema.sql) is a separate,
-- unrelated starter table that nothing writes to; this migration
-- intentionally does not use it, to avoid tracking quantity in two places.
--
-- Run after partner-system-repair.sql. Idempotent.

alter table if exists public.products
  add column if not exists low_stock_threshold integer not null default 5;

alter table if exists public.product_doses
  add column if not exists low_stock_threshold integer not null default 5;
