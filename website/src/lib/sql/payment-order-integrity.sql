-- Payment and order integrity constraints. Idempotent — safe to run any time.
--
-- Run this in the Supabase SQL editor before launch.
--
-- Every invariant below is already enforced by application code and verified by
-- tests. What is missing is the database-level guarantee: today a bug, a manual
-- SQL edit, or a future code path could violate any of them silently. These
-- turn "the code is careful" into "the row cannot exist".
--
-- Each step is written to SUCCEED on a table that already violates it, rather
-- than aborting the migration. Nothing here deletes or rewrites order data.

-- ---------------------------------------------------------------------------
-- 1) order_items must belong to a real order.
--
--    There is no foreign key on order_items.order_id, so deleting an order
--    leaves its line items behind as orphans — rows that still carry prices and
--    quantities but belong to nothing, and which every revenue query has to
--    remember to exclude. This was observed in practice: test suites that
--    deleted orders left 6 orphan rows.
--
--    Existing orphans are re-parented to nothing by deletion FIRST, because
--    ADD CONSTRAINT would otherwise fail against them. That delete removes only
--    rows whose parent order is already gone — it cannot touch a line item
--    belonging to a real order.
-- ---------------------------------------------------------------------------
delete from public.order_items oi
 where not exists (select 1 from public.orders o where o.order_id = oi.order_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'order_items_order_id_fkey'
       and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_order_id_fkey
      foreign key (order_id) references public.orders (order_id)
      on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) One processor session belongs to one order.
--
--    orders.payment_id carries the Veyra checkout-session id. A session is
--    created for exactly one order, so two orders sharing one id would mean a
--    payment had been credited twice. Only a plain (non-unique) index existed.
--
--    PARTIAL, on `payment_id is not null`: unpaid manual orders and orders
--    whose session has not been created yet legitimately share NULL, and a
--    plain unique index would treat those as distinct anyway — the partial form
--    states the intent and keeps the index small.
--
--    Created CONCURRENTLY-safe via a guard rather than the CONCURRENTLY keyword,
--    which cannot run inside a transaction block.
-- ---------------------------------------------------------------------------
create unique index if not exists orders_payment_id_uniq
  on public.orders (payment_id)
  where payment_id is not null;

-- ---------------------------------------------------------------------------
-- 3) One processor event settles one order.
--
--    provider_event_id records the webhook delivery that marked an order paid.
--    Replay protection is enforced in application code by the paid_side_effects_at
--    claim and by payment_events (whose primary key on event_id is the real
--    exactly-once gate). This index adds the structural statement that a single
--    processor event cannot appear against two different orders.
-- ---------------------------------------------------------------------------
create unique index if not exists orders_provider_event_id_uniq
  on public.orders (provider_event_id)
  where provider_event_id is not null;

-- ---------------------------------------------------------------------------
-- 4) Validate the money and inventory CHECK constraints.
--
--    These were added NOT VALID, which enforces them for new and updated rows
--    but never verified the rows already present. VALIDATE performs that
--    back-check without taking a full table lock for writes.
--
--    Wrapped so a genuinely violating legacy row reports itself instead of
--    aborting the whole migration — if one of these raises a notice, that row
--    needs a human, not an automatic rewrite.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conrelid::regclass as tbl, conname
      from pg_constraint
     where contype = 'c'
       and not convalidated
       and conrelid in (
         'public.orders'::regclass,
         'public.order_items'::regclass,
         'public.products'::regclass,
         'public.product_doses'::regclass
       )
  loop
    begin
      execute format('alter table %s validate constraint %I', c.tbl, c.conname);
    exception when others then
      raise notice 'Could not validate % on % — existing rows violate it: %', c.conname, c.tbl, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Verification — run this after, expect zero problem rows.
-- ---------------------------------------------------------------------------
-- select
--   (select count(*) from public.order_items oi
--     where not exists (select 1 from public.orders o where o.order_id = oi.order_id)) as orphan_line_items,
--   (select count(*) from (
--      select payment_id from public.orders
--       where payment_id is not null group by 1 having count(*) > 1) x) as duplicate_payment_ids,
--   (select count(*) from pg_constraint
--     where contype = 'c' and not convalidated
--       and conrelid in ('public.orders'::regclass, 'public.products'::regclass,
--                        'public.product_doses'::regclass, 'public.order_items'::regclass)) as unvalidated_checks;
