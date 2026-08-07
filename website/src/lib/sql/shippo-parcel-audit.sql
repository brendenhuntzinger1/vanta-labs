-- ---------------------------------------------------------------------------
-- Parcel audit trail.
--
-- Additive and idempotent; safe to re-run. No data is changed or removed.
--
-- WHY
-- The parcel sent to Shippo was computed at sync time and then forgotten. Only
-- the inputs survived (product weights, the preset table), and both are
-- editable. So the moment a weight or a box was corrected, there was no way to
-- answer "what did we actually declare on THAT shipment?" -- and that is the
-- question that matters when postage was underpaid, a carrier billed an
-- adjustment, or a parcel was refused.
--
-- These columns record the values as sent, so later edits to products or
-- presets cannot rewrite history.
-- ---------------------------------------------------------------------------

alter table if exists public.orders
  -- Which box was used. Distinct from a manual choice: this is what the
  -- unit-count rule actually selected, recorded whether or not a human picked
  -- it, so "why did this go in a small mailer?" is answerable.
  add column if not exists parcel_preset_id uuid references public.shipping_package_presets(id),
  add column if not exists parcel_preset_name text,

  -- The three numbers Shippo was given.
  add column if not exists parcel_length_in numeric,
  add column if not exists parcel_width_in numeric,
  add column if not exists parcel_height_in numeric,

  -- Weight, broken into its parts rather than only the total. A total alone
  -- cannot distinguish "the vials were heavier than recorded" from "the mailer
  -- tare was wrong", and those have different fixes.
  add column if not exists parcel_merchandise_oz numeric,   -- sum(unit weight x qty)
  add column if not exists parcel_packaging_oz numeric,     -- box tare, added once
  add column if not exists parcel_declared_oz numeric,      -- what Shippo received

  -- True when any line fell back to the catalog default rather than a weighed
  -- value. The declared weight is an ESTIMATE in that case, which is worth
  -- knowing before trusting a postage figure or a margin derived from it.
  add column if not exists parcel_weight_estimated boolean;

-- The reconciliation query: shipments declared on estimated weights, newest
-- first. Partial, so it stays small once everything is weighed.
create index if not exists idx_orders_parcel_estimated
  on public.orders (paid_at desc)
  where parcel_weight_estimated = true;

-- ---------------------------------------------------------------------------
-- VERIFY -- all true.
-- ---------------------------------------------------------------------------
select
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='parcel_preset_id')            as preset_id_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='parcel_declared_oz')          as declared_weight_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='parcel_merchandise_oz')       as merchandise_weight_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='parcel_weight_estimated')     as estimated_flag_ok;
