-- =========================================================================
-- Volume-based product cost reduction — per-order record of the tier applied.
--
-- The store's product cost drops as monthly sales grow:
--
--     $5,000 in a month  → 20% off product cost
--     $10,000 in a month → 30% off product cost
--
-- The reduced cost is already snapshotted per line in
-- order_items.unit_cost_cents at checkout. This column records WHICH tier
-- produced that cost, so a past order's margin can still be explained after
-- the schedule changes — the snapshot says what a unit cost, this says why.
--
-- Nothing reads this to compute money; profit continues to come from the
-- per-line snapshot. It is an audit/explanation column.
--
-- The tier schedule itself is admin-editable and lives in the control table
-- (Admin → Control Center → Profit), not here.
--
-- Run after orders-schema.sql. Idempotent — safe to re-run.
-- =========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'volume_cost_discount_percent'
  ) then
    alter table public.orders add column volume_cost_discount_percent numeric(5,2) not null default 0;
  end if;
end;
$$;

-- A cost reduction outside 0–100% is nonsense and would corrupt every margin
-- report that tries to explain an order. Reject it at the database.
do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where table_schema = 'public'
      and table_name = 'orders'
      and constraint_name = 'orders_volume_cost_discount_percent_range'
  ) then
    alter table public.orders
      add constraint orders_volume_cost_discount_percent_range
      check (volume_cost_discount_percent >= 0 and volume_cost_discount_percent <= 100);
  end if;
end;
$$;

comment on column public.orders.volume_cost_discount_percent is
  'Percent taken off product cost by the monthly-sales volume tier in force when this order was priced. 0 = full cost. Explains the unit_cost_cents snapshot on order_items; never used to recompute money.';
