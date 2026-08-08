-- ===========================================================================
-- ELIJAH-AB78AE — LIVE ORDER VERIFICATION
--
-- Read only. Run one lettered block at a time.
--
-- PRE-FLIGHT (blocks A and B) must pass BEFORE you place the order, or the
-- test proves the wrong thing. Blocks C onward run after payment succeeds.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- A. IS ELIJAH ACTUALLY CONFIGURED THE WAY THE ADMIN CLAIMS?
--
-- Expect: customer_discount 20.00, commission 10.00, status approved,
--         commission_is_manual TRUE.
--
-- commission_is_manual is the one to look at. When it is FALSE and any tier is
-- active, getEffectiveCommissionPercent ignores his 10% and pays the LOWEST
-- active tier -- tiers[0] is assigned before the loop, so zero monthly sales
-- still matches it. Your admin card read "Automatic performance tiers are
-- active", so this is very likely FALSE right now.
-- ---------------------------------------------------------------------------
select
  a.name,
  a.referral_code,
  a.status,
  a.customer_discount_percent          as customer_discount,
  a.commission_percent                 as commission,
  a.commission_percent_locked          as commission_is_manual,
  p.customer_discount_percent          as partners_mirror,
  case when a.customer_discount_percent is distinct from p.customer_discount_percent
       then 'MIRROR STILL DRIFTED' else 'in sync' end as mirror_state
from public.ambassadors a
join public.partners p on p.id = a.id
where a.referral_code = 'ELIJAH-AB78AE';


-- ---------------------------------------------------------------------------
-- B. WOULD A TIER OVERRIDE HIS 10%?
--
-- If block A shows commission_is_manual = false AND this returns any row, the
-- commission on your test order will NOT be 10%.
--
-- FIX: open Elijah's profile and press "Save Commission" on 10. That sets
-- commission_percent_locked = true and pins the rate. Re-run block A.
-- ---------------------------------------------------------------------------
select id, name, min_monthly_sales, commission_percent, is_active
from public.commission_tier_rules
where is_active = true
order by min_monthly_sales;


-- ---------------------------------------------------------------------------
-- C. THE ORDER — the money the customer was charged.
--
-- For a $200 merchandise cart:
--   subtotal            200.00
--   discount_amount      40.00   (20% of 200)
--   merchandise after   160.00
--   shipping_amount       0.00   (free at/above $200 PRE-discount)
--   tax_amount           on 160.00, per your nexus rules
--   amount_paid         160.00 + tax
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.created_at,
  o.payment_status,
  o.referral_code,
  o.ambassador_id is not null                       as attribution_recorded,
  o.subtotal,
  o.discount_amount,
  round(o.subtotal * 0.20, 2)                       as expected_discount,
  o.discount_amount = round(o.subtotal * 0.20, 2)   as discount_correct,
  round(o.subtotal - o.discount_amount, 2)          as commissionable_base,
  o.shipping_amount,
  o.tax_amount,
  o.amount_paid,
  o.paid_at,
  o.paid_side_effects_at
from public.orders o
where o.referral_code = 'ELIJAH-AB78AE'
order by o.created_at desc
limit 5;


-- ---------------------------------------------------------------------------
-- D. THE COMMISSION — the number that decides what you owe.
--
-- Expect on a $200 cart: snapshot_discount 20, snapshot_commission 10,
-- commission_amount 16.00, payment_status 'pending' (inside the hold period).
--
-- commission_math_correct proves the base excludes shipping and tax: it
-- recomputes from (subtotal - discount) and compares to what was stored.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  ro.customer_discount_percent                      as snapshot_discount,
  ro.commission_percent                             as snapshot_commission,
  ro.amount_paid                                    as stored_commission_base,
  ro.commission_amount,
  round((o.subtotal - o.discount_amount) * (ro.commission_percent / 100.0), 2) as expected_commission,
  ro.commission_amount
    = round((o.subtotal - o.discount_amount) * (ro.commission_percent / 100.0), 2) as commission_math_correct,
  -- Shipping and tax must contribute nothing. If this is true, they leaked in.
  ro.commission_amount
    = round((o.subtotal - o.discount_amount + o.shipping_amount + o.tax_amount)
            * (ro.commission_percent / 100.0), 2)   as WARNING_ship_tax_in_base,
  ro.payment_status,
  ro.ineligible_reason
from public.referral_orders ro
join public.orders o on o.order_id = ro.order_id
where o.referral_code = 'ELIJAH-AB78AE'
order by ro.created_at desc
limit 5;


-- ---------------------------------------------------------------------------
-- E. EXACTLY ONE OF EVERYTHING.
--
-- Veyra may deliver the paid webhook more than once. Expect 1 / 1 / 1.
-- Anything higher means an idempotency guard did not hold.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.paid_side_effects_at,
  (select count(*) from public.referral_orders r where r.order_id = o.order_id) as referral_rows,
  (select count(*) from public.commissions   c where c.order_id = o.order_id)   as commission_rows,
  (select count(*) from public.orders x where x.payment_id = o.payment_id
     and o.payment_id is not null)                                              as orders_sharing_payment_id
from public.orders o
where o.referral_code = 'ELIJAH-AB78AE'
order by o.created_at desc
limit 5;


-- ---------------------------------------------------------------------------
-- F. THE MIRROR AGREES WITH ITSELF.
--
-- referral_orders and commissions must carry identical snapshots.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  ro.commission_percent          as referral_orders_commission,
  c.commission_percent           as commissions_commission,
  ro.customer_discount_percent   as referral_orders_discount,
  c.customer_discount_percent    as commissions_discount,
  ro.commission_amount           as referral_orders_amount,
  c.commission_amount            as commissions_amount,
  case when ro.commission_percent is distinct from c.commission_percent
         or ro.commission_amount  is distinct from c.commission_amount
       then 'MISMATCH' else 'agree' end as verdict
from public.referral_orders ro
join public.commissions c on c.order_id = ro.order_id
join public.orders o      on o.order_id = ro.order_id
where o.referral_code = 'ELIJAH-AB78AE'
order by o.created_at desc;


-- ---------------------------------------------------------------------------
-- G. WHAT THE TWO DASHBOARDS WILL SHOW.
--
-- These are the same aggregates the admin roster and Elijah's own dashboard
-- compute. Compare against both screens: they must match to the cent.
-- ---------------------------------------------------------------------------
select
  a.name,
  count(distinct o.order_id) filter (where o.payment_status = 'paid')            as orders,
  coalesce(sum(o.amount_paid) filter (where o.payment_status = 'paid'), 0)       as revenue,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status = 'pending'), 0)            as pending_commission,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status = 'approved_for_payout'), 0) as ready_for_payout,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('pending','approved_for_payout')), 0) as balance_owed,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('paid','commission_paid')), 0)        as paid_out,
  coalesce(sum(ro.commission_amount) filter (where ro.payment_status in ('reversed','voided')), 0)             as reversed
from public.ambassadors a
left join public.orders o           on o.ambassador_id = a.id
left join public.referral_orders ro on ro.order_id = o.order_id
where a.referral_code = 'ELIJAH-AB78AE'
group by a.name;


-- ---------------------------------------------------------------------------
-- H. THE SNAPSHOT, PROVEN.
--
-- Run this AFTER changing Elijah's rate (say 20/10 -> 15/20) following the
-- test order. The order placed at 20/10 must STILL read 20 and 10 here while
-- the ambassador row reads the new numbers. That is the whole point of
-- snapshotting: today's rate never rewrites yesterday's money.
-- ---------------------------------------------------------------------------
select
  o.order_number,
  o.created_at                    as ordered_at,
  ro.customer_discount_percent    as discount_when_ordered,
  ro.commission_percent           as commission_when_ordered,
  ro.commission_amount            as owed_for_this_order,
  a.customer_discount_percent     as discount_today,
  a.commission_percent            as commission_today
from public.referral_orders ro
join public.orders o      on o.order_id = ro.order_id
join public.ambassadors a on a.id = ro.ambassador_id
where a.referral_code = 'ELIJAH-AB78AE'
order by o.created_at asc;
