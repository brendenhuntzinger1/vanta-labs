-- ============================================================================
-- VANTA LABS — Product cost (COGS) tracking
--   1) Snapshot the unit cost into each order line at checkout, so historical
--      orders always calculate profit with the cost that applied THAT day.
--   2) A change-history table: who changed a cost, old -> new, and when.
--   3) Guarantees the internal cost columns exist on products + doses.
-- SAFE + additive + idempotent. Nothing is deleted; storefront prices are
-- untouched. Run in Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================

-- 1) Per-order-line cost snapshot (historical accuracy — never recalculated).
alter table public.order_items
  add column if not exists unit_cost_cents integer;

-- Non-negative guard (NOT VALID so it can't fail on legacy rows; VALIDATE later
-- once you've confirmed there are no negatives).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_unit_cost_cents_nonneg') then
    alter table public.order_items
      add constraint order_items_unit_cost_cents_nonneg
      check (unit_cost_cents is null or unit_cost_cents >= 0) not valid;
  end if;
end $$;

-- 2) Internal cost columns (no-op if they already exist).
alter table public.products      add column if not exists product_cost_cents integer;
alter table public.product_doses add column if not exists product_cost_cents integer;

-- 3) Cost change history — one row per save that actually changed a cost.
create table if not exists public.product_cost_changes (
  id             uuid primary key default gen_random_uuid(),
  product_id     text not null,
  dose_id        text,                    -- null = product-level cost
  product_name   text,
  dose_label     text,
  old_cost_cents integer,
  new_cost_cents integer,
  changed_by     text,                    -- admin username
  changed_at     timestamptz not null default now()
);

create index if not exists product_cost_changes_product_idx
  on public.product_cost_changes (product_id, changed_at desc);
create index if not exists product_cost_changes_changed_at_idx
  on public.product_cost_changes (changed_at desc);

-- Verify what landed:
select 'order_items.unit_cost_cents' as item,
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='order_items' and column_name='unit_cost_cents') as present
union all
select 'product_cost_changes table',
       exists (select 1 from information_schema.tables
               where table_schema='public' and table_name='product_cost_changes');
