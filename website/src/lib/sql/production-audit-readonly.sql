-- ===========================================================================
-- VANTA LABS — PRODUCTION AUDIT (STRICTLY READ ONLY)
--
-- Every statement is a SELECT. Nothing here writes, creates, drops, enables,
-- initializes, recalculates or resets anything. Safe to run on production.
--
-- Supabase's SQL editor returns only the LAST statement's result, so run one
-- lettered block at a time.
-- ===========================================================================


-- A. INVENTORY TRACKING STATUS -- run this first.
-- Absent row  => tracking is OFF (the built-in default) and EVERY product is
-- purchasable in unlimited quantity regardless of stored stock.
select
  l.target_id          as setting,
  l.metadata->>'value' as value,
  l.created_at         as saved_at
from public.admin_audit_logs l
where l.action = 'admin_control_upsert'
  and l.target_table = 'inventory'
order by l.created_at desc;


-- B. EVERY ACTIVE PRODUCT: price, cost, margin, stock.
-- This is the master record. Compare it against any earlier export you have.
select
  p.name,
  p.slug,
  p.price_cents / 100.0                                             as retail_price,
  nullif(p.sale_price_cents, 0) / 100.0                             as sale_price,
  p.product_cost_cents / 100.0                                      as cogs,
  round(
    100.0 * (coalesce(nullif(p.sale_price_cents,0), p.price_cents) - p.product_cost_cents)
    / nullif(coalesce(nullif(p.sale_price_cents,0), p.price_cents), 0)
  , 1)                                                              as margin_pct,
  p.inventory_quantity,
  p.stock_status,
  p.is_published,
  p.is_archived,
  p.updated_at
from public.products p
where coalesce(p.is_archived, false) = false
order by p.name;


-- C. DOSE VARIANTS (what checkout actually charges when a dose is selected).
select
  p.name                                                            as product,
  d.label                                                           as dose,
  d.sku,
  d.price_cents / 100.0                                             as retail_price,
  nullif(d.sale_price_cents, 0) / 100.0                             as sale_price,
  d.inventory_quantity,
  d.stock_status,
  d.is_enabled
from public.product_doses d
join public.products p on p.id = d.product_id
where d.is_enabled = true
  and coalesce(p.is_archived, false) = false
order by p.name, d.position;


-- D. PROOF THAT COSTS AND PRICES WERE NOT TOUCHED.
-- The ambassador work ran roughly 2026-08-07 onward. Any product row whose
-- updated_at falls in that window would need explaining.
-- EXPECTED: zero rows.
select
  name,
  price_cents / 100.0        as retail_price,
  product_cost_cents / 100.0 as cogs,
  inventory_quantity,
  updated_at
from public.products
where updated_at >= '2026-08-07'
order by updated_at desc;


-- E. TOTALS -- one line to eyeball against your own records.
select
  count(*)                                              as active_products,
  sum(inventory_quantity)                               as total_units_on_hand,
  count(*) filter (where product_cost_cents is null
                      or product_cost_cents = 0)        as skus_missing_cogs,
  count(*) filter (where inventory_quantity > 0)        as skus_with_stock,
  min(price_cents) / 100.0                              as cheapest,
  max(price_cents) / 100.0                              as dearest
from public.products
where coalesce(is_archived, false) = false;


-- F. RECENT ORDERS.
select
  order_number,
  created_at,
  payment_status,
  fulfillment_status,
  subtotal,
  discount_amount,
  shipping_amount,
  tax_amount,
  amount_paid,
  refund_amount,
  referral_code,
  ambassador_id is not null as has_ambassador,
  paid_side_effects_at,
  shippo_order_id,
  tracking_number
from public.orders
order by created_at desc
limit 25;


-- G. COUPONS.
select
  code,
  discount_type,
  discount_value,
  active,
  starts_at,
  ends_at,
  max_redemptions,
  redemptions_count,
  assigned_email is not null as is_targeted
from public.coupons
order by active desc, code;


-- H. MEMBERSHIP TIERS AND ACTIVE MEMBERS.
select * from public.membership_tiers order by monthly_price_cents;

select
  status,
  billing_cycle,
  count(*) as members
from public.customer_memberships
group by status, billing_cycle
order by status;


-- I. AMBASSADORS -- both rates, side by side.
-- customer_discount_percent NULL = inheriting the program default (NOT 0%).
-- commission_percent_locked must be TRUE for the rate you set to be the rate
-- that pays; otherwise an active tier can override it.
select
  a.name,
  a.referral_code,
  a.status,
  a.customer_discount_percent                        as customer_discount_pct,
  case when a.customer_discount_percent is null
       then 'inherits program default' else 'override' end as discount_source,
  a.commission_percent                               as commission_pct,
  a.commission_percent_locked                        as commission_is_manual,
  a.created_at
from public.ambassadors a
order by a.status, a.name;

-- The partners mirror must agree with it, row for row.
-- EXPECTED: zero rows.
select
  a.referral_code,
  a.customer_discount_percent as ambassadors_value,
  p.customer_discount_percent as partners_value,
  a.commission_percent        as ambassadors_commission,
  p.commission_percent        as partners_commission
from public.ambassadors a
full outer join public.partners p on p.id = a.id
where a.customer_discount_percent is distinct from p.customer_discount_percent
   or a.commission_percent is distinct from p.commission_percent
   or a.id is null or p.id is null;


-- J. THE $100 MINIMUM AND THE REST OF THE PROGRAM POLICY.
-- A missing row means the built-in fallback is in force, NOT that the value
-- is unset in behaviour. Defaults: minimum_qualifying_order 100,
-- commission_hold_days 30, minimum_payout_threshold 100, discount_percent 10.
select
  l.target_table       as section,
  l.target_id          as setting,
  l.metadata->>'value' as value,
  l.created_at         as saved_at
from public.admin_audit_logs l
where l.action = 'admin_control_upsert'
  and l.target_table in ('ambassador', 'referral')
  and l.created_at = (
    select max(l2.created_at) from public.admin_audit_logs l2
    where l2.action = 'admin_control_upsert'
      and l2.target_table = l.target_table
      and l2.target_id = l.target_id
  )
order by l.target_table, l.target_id;


-- K. COMMISSIONS ON RECORD.
select
  payment_status,
  count(*)                     as rows,
  sum(commission_amount)       as total_amount,
  min(created_at)              as oldest,
  max(created_at)              as newest
from public.referral_orders
group by payment_status
order by payment_status;


-- L. SHIPPO / SHIPPING CONFIGURATION (stored settings, no tokens involved).
select
  l.target_table       as section,
  l.target_id          as setting,
  l.metadata->>'value' as value,
  l.created_at         as saved_at
from public.admin_audit_logs l
where l.action = 'admin_control_upsert'
  and l.target_table in ('shipping', 'fulfillment')
  and l.created_at = (
    select max(l2.created_at) from public.admin_audit_logs l2
    where l2.action = 'admin_control_upsert'
      and l2.target_table = l.target_table
      and l2.target_id = l.target_id
  )
order by l.target_table, l.target_id;

-- Shippo handoff health across recent orders.
select
  count(*)                                                  as orders_total,
  count(*) filter (where shippo_order_id is not null)        as pushed_to_shippo,
  count(*) filter (where shippo_sync_status = 'blocked')     as sync_blocked,
  count(*) filter (where tracking_number is not null)        as have_tracking
from public.orders
where payment_status = 'paid';


-- M. PAYMENT PROCESSOR POSTURE (inferred from data -- credentials live in env
-- and are never selectable from SQL, which is correct).
select
  payment_method,
  payment_status,
  count(*)          as orders,
  max(created_at)   as most_recent
from public.orders
group by payment_method, payment_status
order by most_recent desc nulls last;


-- N. ADMIN SECURITY POSTURE.
select username, role, is_active, created_at
from public.admin_credentials
order by created_at;

select count(*) as live_admin_sessions
from public.admin_sessions
where expires_at > now();
