-- ===========================================================================
-- VL-7 / P12-01 — `manual_review` is a commission status the code WRITES, so
-- the CHECK has to admit it.
--
-- WHAT IS WRONG. `referral_orders.payment_status` carries the COMMISSION
-- lifecycle (see referral-orders-commission-lifecycle.sql, which widened it
-- from production's original three order-payment values). One value was left
-- out of that list, and it is the one the refund path writes:
--
--   payment-webhook.ts getCommissionStateForRefund()
--     a FULL refund of an order whose commission was ALREADY PAID
--       -> payment_status = 'manual_review'
--   payment-webhook.ts updateCommissionOnRefund()
--     a PARTIAL refund of an order whose commission was ALREADY PAID
--       -> payment_status = 'manual_review'
--
-- Both are refused with 23514. The rest of the codebase already treats
-- 'manual_review' as a first-class lifecycle value and has for a long time:
--   src/lib/ledger.ts            EXCLUDED_COMMISSION_STATUSES
--   src/lib/admin-ambassadors.ts reversal + flagged-row queries
--   src/lib/partner-portal.ts    earned-commission rule
--   sql/admin-partner-rollups.sql, sql/BASELINE-live-functions-2026-08-25.sql
-- so the constraint is the thing that is wrong, exactly as it was for
-- 'pending' and 'approved_for_payout'.
--
-- WHY IT MATTERS BEYOND THE COMMISSION ROW. The write happens INSIDE the
-- webhook's refund branch, and until the companion fix in payment-webhook.ts
-- that branch had no try/catch around it: the 23514 aborted the whole refund —
-- no commission reversal, no restock, no points/store-credit return — and the
-- processor's retry was then short-circuited by the already-terminal guard, so
-- the work was lost rather than deferred (REF-02). An ambassador sale that got
-- refunded after payout therefore left sold stock off the shelf permanently.
--
-- BLAST RADIUS. Widening a CHECK cannot invalidate an existing row. No writer
-- loses a value; one that was already being attempted starts succeeding.
-- ===========================================================================

-- DROP BY RULE, NOT BY NAME — same reasoning as
-- referral-orders-commission-lifecycle.sql. The browser harness carries a
-- second, differently-named constraint (`pc_ro_ps`) enforcing the ORIGINAL
-- three-value rule, added by src/lib/sql/harness-prod-parity-constraints.sql.
-- A by-name migration widens one and leaves the other in force, and every
-- refund of a paid commission still fails — with a migration that reported
-- success.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class t on t.oid = con.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'referral_orders'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%payment_status%'
      -- Only constraints that would REFUSE the write. One that already permits
      -- 'manual_review' is this migration re-running, or something deliberately
      -- wider; neither should be destroyed.
      and pg_get_constraintdef(con.oid) not like '%''manual_review''%'
  loop
    raise notice 'dropping narrow payment_status constraint %', c.conname;
    execute format('alter table public.referral_orders drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.referral_orders
  drop constraint if exists referral_orders_payment_status_check;

alter table public.referral_orders
  add constraint referral_orders_payment_status_check
  check (payment_status = any (array[
    -- accrued, inside the commission hold period
    'pending',
    -- hold period elapsed, cleared for the next payout run
    'approved_for_payout',
    -- paid out to the ambassador
    'paid',
    -- clawed back after a refund, or cancelled by an admin
    'reversed',
    'voided',
    -- refunded AFTER the commission was paid out: the money is already gone, so
    -- it cannot be clawed back automatically and an admin reconciles it. THIS
    -- IS THE VALUE THE REFUND PATH WRITES.
    'manual_review',
    -- the order behind it was refunded; kept for reporting
    'refunded',
    'partially_refunded'
  ]));

-- Same safe default as the lifecycle migration: an accrual that has to be
-- cleared before it can be paid.
alter table public.referral_orders
  alter column payment_status set default 'pending';
