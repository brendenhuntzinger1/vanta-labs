-- ===========================================================================
-- VANTA LABS — AMBASSADOR END-TO-END VERIFICATION (READ ONLY)
--
-- Nothing in this file writes. Every query is a SELECT.
--
-- Run the numbered blocks at the points the runbook tells you to. The block
-- numbers match the runbook steps.
--
-- Replace 'VLTEST' with your test ambassador's referral code wherever it
-- appears if you chose a different one.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- BLOCK 0 — PRE-FLIGHT. Run BEFORE placing any order.
--
-- Three settings decide whether a commission can accrue at all. If the
-- minimum qualifying order is above your test cart's PRE-discount subtotal,
-- the commission will correctly record as $0.00 and the test will look broken
-- when it is not.
-- ---------------------------------------------------------------------------
-- Program settings are NOT a settings table -- they are stored as the newest
-- audit-log row per key (section = target_table, key = target_id, the value
-- inside metadata). A key that has never been saved simply has no row, and the
-- code falls back to its built-in default. Those defaults are:
--   minimum_qualifying_order  100      <-- the one that will surprise you
--   commission_hold_days       30
--   referral discount_percent  10
select
  l.target_table              as section,
  l.target_id                 as setting,
  l.metadata->>'value'        as value,
  l.created_at                as set_at
from public.admin_audit_logs l
where l.action = 'admin_control_upsert'
  and l.target_table in ('referral', 'ambassador')
  and l.created_at = (
    select max(l2.created_at)
    from public.admin_audit_logs l2
    where l2.action = 'admin_control_upsert'
      and l2.target_table = l.target_table
      and l2.target_id = l.target_id
  )
order by l.target_table, l.target_id;
-- READ: referral/enabled must not be false. referral/commissions_paused must
-- not be true. ambassador/minimum_qualifying_order must be <= your test cart's
-- PRE-discount subtotal -- if the row is absent, the effective minimum is $100
-- and a smaller test order will correctly earn $0.00 commission.


-- ---------------------------------------------------------------------------
-- BLOCK 1 — THE TEST AMBASSADOR, BEFORE ORDER #1.
--
-- Expected: customer_discount_pct 10, ambassador_earns_pct 15,
-- commission_is_manual TRUE, status approved.
--
-- commission_is_manual MUST be true. When it is false and any active
-- commission tier exists, the tier rate silently replaces the rate you set
-- and order #1 will not record 15%.
-- ---------------------------------------------------------------------------
select
  a.id,
  a.name,
  a.referral_code,
  a.status,
  a.customer_discount_percent      as customer_discount_pct,
  case when a.customer_discount_percent is null
       then 'INHERITING program default' else 'OVERRIDE' end as discount_source,
  a.commission_percent             as ambassador_earns_pct,
  a.commission_percent_locked      as commission_is_manual
from public.ambassadors a
where a.referral_code = 'VLTEST';

-- Any ACTIVE tier is a hazard for an unlocked ambassador. Informational.
select id, name, min_monthly_sales, commission_percent, is_active
from public.commission_tier_rules
where is_active = true
order by min_monthly_sales;


-- ---------------------------------------------------------------------------
-- BLOCK 2 — ORDER #1, THE MONEY. Run after payment succeeds.
--
-- discount_amount must equal round(subtotal * 0.10, 2).
-- The commission base is subtotal MINUS discount -- not the gross total, and
-- not the pre-discount subtotal.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.payment_status,
  o.referral_code,
  o.ambassador_id is not null            as attribution_recorded,
  o.subtotal,
  o.discount_amount,
  round(o.subtotal * 0.10, 2)            as expected_discount_at_10pct,
  o.discount_amount = round(o.subtotal * 0.10, 2) as discount_correct,
  round(o.subtotal - o.discount_amount, 2) as commission_base,
  o.shipping_amount,
  o.tax_amount,
  o.amount_paid,
  o.paid_at,
  o.paid_side_effects_at
from public.orders o
where o.referral_code = 'VLTEST'
order by o.created_at desc;


-- ---------------------------------------------------------------------------
-- BLOCK 3 — ORDER #1, THE SNAPSHOT. The core of the whole test.
--
-- Expected on the referral_orders row:
--   commission_percent          15
--   customer_discount_percent   10
--   commission_amount           round((subtotal - discount) * 0.15, 2)
--   payment_status              pending   (it is inside the hold period)
-- ---------------------------------------------------------------------------
select
  o.order_number,
  ro.commission_percent           as snapshot_commission_pct,
  ro.customer_discount_percent    as snapshot_discount_pct,
  ro.commission_amount,
  round((o.subtotal - o.discount_amount) * (ro.commission_percent / 100.0), 2)
                                  as expected_commission,
  ro.commission_amount = round((o.subtotal - o.discount_amount) * (ro.commission_percent / 100.0), 2)
                                  as commission_math_correct,
  ro.payment_status,
  ro.review_required,
  ro.review_reason,
  ro.created_at
from public.referral_orders ro
join public.orders o on o.order_id = ro.order_id
where o.referral_code = 'VLTEST'
order by ro.created_at desc;

-- The commissions mirror must agree with referral_orders row for row.
select
  o.order_number,
  c.commission_percent          as snapshot_commission_pct,
  c.customer_discount_percent   as snapshot_discount_pct,
  c.commission_amount,
  c.status
from public.commissions c
join public.orders o on o.order_id = c.order_id
where o.referral_code = 'VLTEST'
order by c.created_at desc;


-- ---------------------------------------------------------------------------
-- BLOCK 4 — DUPLICATE WEBHOOK PROTECTION.
--
-- Exactly ONE referral_orders row and ONE commissions row per order, however
-- many times the processor delivered the webhook. paid_side_effects_at is the
-- claim that guarantees it: the first delivery flips it NULL -> timestamp and
-- every later delivery finds it already set.
--
-- EXPECTED: referral_rows = 1 and commission_rows = 1 for every order.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.paid_side_effects_at,
  (select count(*) from public.referral_orders r where r.order_id = o.order_id) as referral_rows,
  (select count(*) from public.commissions   c where c.order_id = o.order_id) as commission_rows
from public.orders o
where o.referral_code = 'VLTEST'
order by o.created_at desc;


-- ---------------------------------------------------------------------------
-- BLOCK 5 — THE ADMIN'S NUMBERS, FROM THE DATABASE.
--
-- These are the same aggregates the roster and the ambassador dashboard show.
-- If a number on screen disagrees with this, the UI is wrong, not the data.
-- ---------------------------------------------------------------------------
select
  a.name,
  a.referral_code,
  count(distinct o.order_id) filter (where o.payment_status = 'paid')   as paid_orders,
  coalesce(sum(o.amount_paid) filter (where o.payment_status = 'paid'), 0) as revenue,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status = 'pending'), 0)
                                                                        as pending_commission,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status = 'approved_for_payout'), 0)
                                                                        as ready_for_payout,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('pending','approved_for_payout')), 0)
                                                                        as balance_owed,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('paid','commission_paid')), 0)
                                                                        as paid_out,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('reversed','voided')), 0)
                                                                        as reversed
from public.ambassadors a
left join public.orders o           on o.ambassador_id = a.id
left join public.referral_orders ro on ro.order_id = o.order_id
where a.referral_code = 'VLTEST'
group by a.name, a.referral_code;


-- ---------------------------------------------------------------------------
-- BLOCK 6 — THE PROOF. Run only AFTER order #2, with the rates changed
-- to 15% customer / 20% commission between the two orders.
--
-- THIS IS THE RESULT THAT MATTERS. Read it as two rows:
--
--   oldest row (order #1):  snapshot_discount_pct = 10, snapshot_commission_pct = 15
--   newest row (order #2):  snapshot_discount_pct = 15, snapshot_commission_pct = 20
--
--   ambassadors_discount_today = 15 and ambassadors_commission_today = 20
--   on BOTH rows -- the live rate moved, the historical rows did not.
--
-- If order #1 now reads 15/20, the snapshot is not working and the system is
-- recomputing history from the current rate. That is the exact failure this
-- design exists to prevent.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.created_at                    as ordered_at,
  o.subtotal,
  o.discount_amount,
  round(100.0 * o.discount_amount / nullif(o.subtotal, 0), 2)
                                  as discount_pct_actually_charged,
  ro.customer_discount_percent    as snapshot_discount_pct,
  ro.commission_percent           as snapshot_commission_pct,
  ro.commission_amount,
  a.customer_discount_percent     as ambassadors_discount_today,
  a.commission_percent            as ambassadors_commission_today,
  ro.payment_status
from public.referral_orders ro
join public.orders o      on o.order_id = ro.order_id
join public.ambassadors a on a.id = ro.ambassador_id
where a.referral_code = 'VLTEST'
order by o.created_at asc;

-- The same thing as a single pass/fail. Expect snapshot_held = true.
with rates as (
  select
    ro.customer_discount_percent as d,
    ro.commission_percent        as c,
    row_number() over (order by o.created_at asc) as n
  from public.referral_orders ro
  join public.orders o      on o.order_id = ro.order_id
  join public.ambassadors a on a.id = ro.ambassador_id
  where a.referral_code = 'VLTEST'
)
select
  (select d from rates where n = 1) as order1_discount,
  (select c from rates where n = 1) as order1_commission,
  (select d from rates where n = 2) as order2_discount,
  (select c from rates where n = 2) as order2_commission,
  (select d from rates where n = 1) = 10
    and (select c from rates where n = 1) = 15
    and (select d from rates where n = 2) = 15
    and (select c from rates where n = 2) = 20 as snapshot_held;


-- ---------------------------------------------------------------------------
-- BLOCK 7 — REFUND BEHAVIOR. Run after each refund test.
--
-- FULL refund   -> payment_status 'reversed' (or 'manual_review' if the
--                  commission had already been paid out), commission_amount
--                  left as the original figure, reversed_at set.
-- PARTIAL refund -> commission_amount reduced in proportion to the refunded
--                  share; payment_status unchanged unless it was already paid,
--                  in which case review_required flips true.
--
-- Recomputed from the STORED base and percent each time, so two successive
-- partial refunds do not compound off an already-reduced number.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.payment_status                as order_payment_status,
  o.refund_amount,
  o.amount_paid,
  round(o.refund_amount / nullif(o.amount_paid, 0), 4) as refunded_fraction,
  ro.commission_percent,
  ro.commission_amount            as commission_now,
  ro.payment_status               as commission_status,
  ro.reversed_at,
  ro.review_required,
  ro.review_reason
from public.orders o
join public.referral_orders ro on ro.order_id = o.order_id
where o.referral_code = 'VLTEST'
order by o.created_at desc;


-- ---------------------------------------------------------------------------
-- BLOCK 8 — DISABLED AMBASSADOR. Run after ordering with the code while the
-- ambassador is disabled.
--
-- EXPECTED: commission_percent 0, commission_amount 0.00, and an
-- ineligible_reason naming the ambassador as inactive. Attribution is still
-- recorded -- the order still knows where it came from, it just earns nothing.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.referral_code,
  o.ambassador_id is not null as attribution_still_recorded,
  ro.commission_percent,
  ro.commission_amount,
  ro.ineligible_reason,
  ro.payment_status
from public.orders o
left join public.referral_orders ro on ro.order_id = o.order_id
where o.referral_code = 'VLTEST'
order by o.created_at desc
limit 3;


-- ---------------------------------------------------------------------------
-- BLOCK 9 — FAILED / ABANDONED PAYMENT.
--
-- EXPECTED: the order exists with payment_status 'pending_payment' (or
-- 'failed'), paid_side_effects_at IS NULL, and NO referral_orders row at all.
-- A commission must never exist for an order that was not paid.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.payment_status,
  o.paid_side_effects_at,
  (select count(*) from public.referral_orders r where r.order_id = o.order_id) as commission_rows
from public.orders o
where o.referral_code = 'VLTEST'
  and o.payment_status <> 'paid'
order by o.created_at desc;


-- ---------------------------------------------------------------------------
-- BLOCK 10 — INHERITANCE vs OVERRIDE, ACROSS THE WHOLE PROGRAM.
--
-- After clearing the test ambassador's discount field in the admin, their
-- customer_discount_percent must be NULL -- not 0. NULL follows the program
-- default; 0 would silently stop discounting while the code kept working.
-- ---------------------------------------------------------------------------
select
  name,
  referral_code,
  status,
  customer_discount_percent,
  case
    when customer_discount_percent is null then 'inherits program default'
    when customer_discount_percent = 0     then 'deliberate 0% (no discount)'
    else 'override'
  end as discount_mode,
  commission_percent,
  commission_percent_locked
from public.ambassadors
order by status, name;
