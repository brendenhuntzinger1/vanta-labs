-- =====================================================================
-- VANTA LABS — PRODUCTION SCHEMA READINESS
--
-- READ-ONLY. Writes nothing, changes nothing, safe to run any time.
--
-- The repository has 107 .sql files and no migration-tracking table, so
-- nothing in the application can tell you which of them production has
-- actually had applied. This query answers that question directly: it asks
-- the live database which objects exist, and compares that against exactly
-- what the code merged to main requires in order to run.
--
-- Every row that comes back MISSING is something the code will call for and
-- the database will refuse. Run this BEFORE the two-order certification.
-- =====================================================================

with required(kind, object_name, needed_for) as (
  values
    -- Tables the fulfillment Workstation and the postage path require.
    ('table', 'fulfillment_batches',        'Workstation batching — Ready to Fulfill -> Batch -> Pick -> Pack'),
    ('table', 'fulfillment_batch_orders',   'Batch membership; also fixes label/packing order'),
    ('table', 'order_shipments',            'Purchased label, tracking, carrier, transaction id'),
    ('table', 'order_shipping_cost_audit',  'Estimate-vs-actual postage history'),
    ('table', 'shippo_webhook_events',      'Exactly-once carrier tracking events'),
    ('table', 'payment_events',             'Exactly-once payment webhooks'),
    ('table', 'system_alerts',              'Operator alerting — the Status page reads this'),
    ('table', 'inventory_transactions',     'Inventory ledger — every movement, explainable'),
    ('table', 'order_status_history',       'Fulfillment state-change audit trail'),
    ('table', 'shipping_package_presets',   'Mailer tare weight for parcel calculation'),
    ('table', 'admin_audit_logs',           'Who did the dangerous thing, and when'),
    ('table', 'pending_emails',             'Email retry queue — a send failure is not a sent email'),

    -- Columns on `orders` the merged code reads or writes by name.
    ('column', 'orders.label_purchase_claimed_at', 'Atomic claim — stops a double label purchase'),
    ('column', 'orders.paid_side_effects_at',      'Atomic claim — stops double inventory/commission on a webhook retry'),
    ('column', 'orders.label_purchased_at',        'Stale-shipment detection (carrier never scanned)'),
    ('column', 'orders.shipped_at',                'Stale-shipment detection (transit stalled)'),
    ('column', 'orders.shippo_order_id',           'Shippo sync + the shipment-repair sweep'),
    ('column', 'orders.actual_shipping_cost_cents','Real postage paid — profit finalization'),
    ('column', 'orders.estimated_shipping_cost_cents', 'Pre-ship estimate, kept distinct from actual'),
    ('column', 'orders.shipping_cost_source',      'Which of the two the profit figure is using'),
    ('column', 'orders.profit_finalized',          'Estimated vs finalized profit'),
    ('column', 'orders.order_type',                'Separates replacements from sales in every revenue figure'),
    ('column', 'orders.replacement_of',            'Links a reshipment to the original paid order'),
    ('column', 'orders.replacement_reason',        'Why the reshipment happened'),
    ('column', 'orders.customer_user_id',          'Order ownership that survives an email change'),

    -- Columns elsewhere.
    ('column', 'order_items.unit_cost_cents',      'COGS SNAPSHOT — historical profit immutability depends on it'),
    ('column', 'products.track_inventory',         'Oversell protection'),
    ('column', 'products.inventory_quantity',      'Oversell protection'),

    -- The function that actually enforces the oversell rule.
    ('function', 'reserve_inventory',              'Server-side stock reservation — the only thing stopping an oversell')
)
select
  r.kind,
  r.object_name,
  case
    when r.kind = 'table' then
      case when exists (
        select 1 from information_schema.tables t
        where t.table_schema = 'public' and t.table_name = r.object_name
      ) then 'PRESENT' else '*** MISSING ***' end
    when r.kind = 'column' then
      case when exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name  = split_part(r.object_name, '.', 1)
          and c.column_name = split_part(r.object_name, '.', 2)
      ) then 'PRESENT' else '*** MISSING ***' end
    else
      case when exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = r.object_name
      ) then 'PRESENT' else '*** MISSING ***' end
  end as status,
  r.needed_for
from required r
order by
  -- Everything missing floats to the top, so a clean run is a screen of PRESENT
  -- and a dirty one puts the problem in row 1.
  (case
     when r.kind = 'table' then (select count(*) from information_schema.tables t
       where t.table_schema = 'public' and t.table_name = r.object_name)
     when r.kind = 'column' then (select count(*) from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name  = split_part(r.object_name, '.', 1)
         and c.column_name = split_part(r.object_name, '.', 2))
     else (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = r.object_name)
   end),
  r.kind,
  r.object_name;
