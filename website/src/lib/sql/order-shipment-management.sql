-- Phase 4 admin dashboard: shipping management.
--
-- public.order_shipments already exists (partner-portal-schema.sql) but
-- nothing wrote to it. The admin order detail page now upserts one shipment
-- row per order (carrier/tracking/status/estimated delivery) whenever
-- fulfillment status is updated - this adds the unique constraint that
-- upsert (onConflict: "order_id") requires, since the table only had a
-- foreign key on order_id, not a uniqueness guarantee.
--
-- Run after partner-portal-schema.sql. Idempotent.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_shipments_order_id_key'
  ) then
    alter table public.order_shipments
      add constraint order_shipments_order_id_key unique (order_id);
  end if;
end;
$$;
