-- ============================================================================
-- VERIFIED PRODUCTION ROW COUNTS — measured READ-ONLY on 2026-08-26.
-- These are the affected-row counts each section below is expected to touch.
-- Production may have moved on since they were gathered: RE-VERIFY every
-- count immediately before executing ANY section of this file, by re-running
-- the corresponding read-only SELECT from task-9-brief.md Step 1 (or the
-- equivalent SELECT already inlined in each section below).
--
--   B1 — published products with a stale parent cost (that have doses): 38
--   B3 — order_items still at the inherited EvoLabs cost:                 4
--   B4 — cerebrolysin/pinealon DOSE rows carrying a cost:                 2
--   B4 — cerebrolysin/pinealon PARENT rows carrying a cost:               2
--   B5 — fulfillment_orders:                                              2
--   B5 — fulfillment_payouts:                                             2
--   B5 — fulfillment_events:                                            194
--   A1 — labels bought with no recorded postage:                          2
--   A4 — shipped, no Shippo transaction (needs manual cost entry):        1
-- ============================================================================

-- ============================================================================
-- PHASE 2 — NOT APPLIED. REQUIRES EXPLICIT OWNER APPROVAL BEFORE ANY EXECUTION.
--
-- Every statement below mutates production financial data. None has been run.
-- Run section by section, checking the verification SELECT after each before
-- proceeding. Sections are ordered so that nothing destructive precedes its
-- own archive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1 — audit table for the cost restatement (additive, non-destructive)
-- ---------------------------------------------------------------------------
create table if not exists public.order_cost_restatements (
  id              uuid primary key default gen_random_uuid(),
  order_id        text not null,
  order_item_id   uuid not null,
  old_cost_cents  integer,
  new_cost_cents  integer not null,
  reason          text not null,
  restated_by     text not null,
  restated_at     timestamptz not null default now()
);
alter table public.order_cost_restatements enable row level security;

-- ---------------------------------------------------------------------------
-- SECTION 2 — archive the dead EvoLabs 3PL tables. RUN BEFORE SECTION 3.
-- Expected: 2 / 2 / 194 rows.
--
-- RE-RUNNING THIS SECTION DOES NOT REFRESH THE ARCHIVES. `create table if not
-- exists ... as select` SILENTLY KEEPS an archive created by an earlier run
-- and copies nothing — and the verify below only compares COUNTS, so a stale
-- archive holding the same number of rows passes while containing different
-- data. To re-archive, drop the three archive tables first:
--
--   drop table if exists public.archive_fulfillment_events;
--   drop table if exists public.archive_fulfillment_payouts;
--   drop table if exists public.archive_fulfillment_orders;
--
-- `create table ... as select` does NOT inherit row-level security from the
-- source table: it produces a brand-new table with RLS OFF. PostgREST exposes
-- every table in `public`, so archive_fulfillment_payouts — payout amounts and
-- recipients — would be readable with the anon key. Section 1 already enables
-- RLS on the table it creates; these three must match it.
-- ---------------------------------------------------------------------------
create table if not exists public.archive_fulfillment_orders  as select * from public.fulfillment_orders;
create table if not exists public.archive_fulfillment_payouts as select * from public.fulfillment_payouts;
create table if not exists public.archive_fulfillment_events  as select * from public.fulfillment_events;

alter table public.archive_fulfillment_orders  enable row level security;
alter table public.archive_fulfillment_payouts enable row level security;
alter table public.archive_fulfillment_events  enable row level security;

-- VERIFY: each pair must match before Section 3 runs.
select 'orders'  as t, (select count(*) from public.fulfillment_orders)  as live,
                        (select count(*) from public.archive_fulfillment_orders)  as archived
union all
select 'payouts', (select count(*) from public.fulfillment_payouts), (select count(*) from public.archive_fulfillment_payouts)
union all
select 'events',  (select count(*) from public.fulfillment_events),  (select count(*) from public.archive_fulfillment_events);

-- ---------------------------------------------------------------------------
-- SECTION 3 — DESTRUCTIVE. Only after Section 2 verified equal counts.
-- ---------------------------------------------------------------------------
delete from public.fulfillment_events;
delete from public.fulfillment_payouts;
delete from public.fulfillment_orders;

-- ---------------------------------------------------------------------------
-- SECTION 4 — null the inherited EvoLabs parent costs.
-- Only for products that HAVE doses; a product with no dose rows keeps its
-- parent cost, which is the one case product-cogs.sql says it is for.
-- ---------------------------------------------------------------------------
update public.products p
   set product_cost_cents = null,
       updated_at = now()
 where p.is_published
   and p.product_cost_cents is not null
   and exists (select 1 from public.product_doses d where d.product_id = p.id);

-- VERIFY: expect 0.
select count(*) from public.products p
 where p.is_published and p.product_cost_cents is not null
   and exists (select 1 from public.product_doses d where d.product_id = p.id);

-- ---------------------------------------------------------------------------
-- SECTION 5 — cerebrolysin / pinealon: no cost on file.
-- Excluded from the landed-cost invoice; still carrying EvoLabs' 3500.
-- Expected: 2 dose rows and 2 parent rows.
--
-- GUARDED ON THE VALUE, like Section 6, so this only clears the figure it is
-- meant to clear. Without the guard a re-run would wipe a REAL landed cost
-- entered by hand in the meantime — the two products are on the invoice list
-- precisely because someone is expected to price them later.
-- ---------------------------------------------------------------------------
update public.product_doses d
   set product_cost_cents = null, updated_at = now()
  from public.products p
 where p.id = d.product_id
   and p.slug in ('cerebrolysin', 'pinealon')
   and d.product_cost_cents = 3500;

update public.products
   set product_cost_cents = null, updated_at = now()
 where slug in ('cerebrolysin', 'pinealon')
   and product_cost_cents = 3500;

-- VERIFY: expect 0 and 0 — nothing left on either table at the EvoLabs figure.
-- A NON-ZERO RESULT MEANS THE GUARD DID NOT MATCH, not that the update failed:
-- the stored figure is no longer 3500. Read the actual value before touching
-- the guard — someone may have entered a real landed cost since 2026-08-26.
select (select count(*) from public.product_doses d
          join public.products p on p.id = d.product_id
         where p.slug in ('cerebrolysin', 'pinealon')
           and d.product_cost_cents is not null) as dose_rows_with_cost,
       (select count(*) from public.products
         where slug in ('cerebrolysin', 'pinealon')
           and product_cost_cents is not null) as parent_rows_with_cost;

-- ---------------------------------------------------------------------------
-- SECTION 6 — restate the four order lines frozen at EvoLabs seed costs.
-- Audit row FIRST, then the update, so the old value is captured before it is
-- overwritten. Each update is guarded on the old value, so re-running is a
-- no-op rather than a second restatement.
-- ---------------------------------------------------------------------------
insert into public.order_cost_restatements
  (order_id, order_item_id, old_cost_cents, new_cost_cents, reason, restated_by)
select i.order_id, i.id, i.unit_cost_cents, v.new_cost,
       'Frozen at inherited EvoLabs seed cost; restated to the landed cost in sql/product-cogs.sql',
       'financial-reconciliation-audit'
  from public.order_items i
  join (values
    ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 'glp-1', 2456, 383),
    ('order-6d2fbba4-0f72-412b-850e-385017d11342', 'mots-c::aa26520e-6267-4027-98dc-238e2ced3c97', 2520, 768),
    ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 'bacteriostatic-water', 800, 143),
    ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', '5-amino-1mq', 3300, 1066)
  ) as v(order_id, product_id, old_cost, new_cost)
    on v.order_id = i.order_id and v.product_id = i.product_id
 where i.unit_cost_cents = v.old_cost;

update public.order_items i
   set unit_cost_cents = v.new_cost
  from (values
    ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 'glp-1', 2456, 383),
    ('order-6d2fbba4-0f72-412b-850e-385017d11342', 'mots-c::aa26520e-6267-4027-98dc-238e2ced3c97', 2520, 768),
    ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 'bacteriostatic-water', 800, 143),
    ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', '5-amino-1mq', 3300, 1066)
  ) as v(order_id, product_id, old_cost, new_cost)
 where v.order_id = i.order_id and v.product_id = i.product_id
   and i.unit_cost_cents = v.old_cost;

-- VERIFY: expect 4 restatement rows and 0 lines still at the old cost.
--
-- The restatement count is SCOPED TO THESE FOUR ORDERS. Counting the whole
-- table made the check meaningless the moment a second restatement was ever
-- recorded: it would read 5, 6, 12 and "expect 4" would fail on a run that had
-- worked perfectly, or — worse — read 4 from four unrelated rows while this
-- section had inserted none.
select (select count(*) from public.order_cost_restatements
         where order_id in (
           'order-b8a56a42-d949-48a6-9a9a-b408d51c5006',
           'order-6d2fbba4-0f72-412b-850e-385017d11342',
           'order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa',
           'order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5')) as restated,
       (select count(*) from public.order_items
         where (order_id, unit_cost_cents) in (
           ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 2456),
           ('order-6d2fbba4-0f72-412b-850e-385017d11342', 2520),
           ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 800),
           ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', 3300))) as still_old;

-- ---------------------------------------------------------------------------
-- SECTION 7 — NOT SQL. Two manual actions for the owner.
--
-- A4. Order VL-E8F4D52F (order-b8a56a42-…) shipped on a hand-entered UPS
--     tracking number with no Shippo transaction, so its real postage is not
--     recoverable by any query or API call. The repair sweep cannot see it
--     (it has no label_purchased_at). The owner must enter the cost in
--     Admin -> Orders -> VL-E8F4D52F, which routes through
--     recordActualShippingCost with source 'manual'. NO SQL IS OFFERED HERE:
--     inventing a figure would be worse than the gap.
--
-- D1. Persist the processor fee explicitly. Admin -> Control Center -> Profit,
--     set "processing fee percent" to 8 and save. It is stored as an
--     admin_control_upsert audit row, not a table column, so it must be set
--     through the UI rather than by SQL.
-- ---------------------------------------------------------------------------
