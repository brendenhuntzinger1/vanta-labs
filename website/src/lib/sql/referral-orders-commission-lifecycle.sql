-- ===========================================================================
-- M-01 — let a commission exist, and let it move.
--
-- WHAT IS WRONG. `referral_orders.payment_status` carries the COMMISSION
-- lifecycle in this codebase — accrued, cleared for payout, paid out, reversed.
-- Production's CHECK admits only three values, and they describe the ORDER's
-- payment state instead:
--
--   referral_orders_payment_status_check
--     CHECK (payment_status = ANY (ARRAY['paid','refunded','partially_refunded']))
--
-- Consequences, all verified against production with a rolled-back DO block:
--   * the accrual writes 'pending'            -> 23514, every time
--   * autoApproveEligibleCommissions writes
--     'approved_for_payout'                   -> 23514, every time
--   * markCommissionsPaid writes 'paid'       -> permitted, but unreachable,
--                                                because nothing ever becomes
--                                                approved_for_payout
--
-- Production has 0 commissions and 0 referral_orders. Nobody has noticed because
-- no paid order has ever carried a referral code. The first real ambassador sale
-- loses its commission silently: the insert is caught and logged as "Unable to
-- record commission for order …", and the webhook carries on returning success.
--
-- WHY THE CONSTRAINT IS THE THING THAT MOVES, NOT THE CODE. All three
-- definitions of this table in the repository —
--   src/lib/sql/deploy-run-once.sql
--   src/lib/sql/orders-schema.sql
--   src/lib/sql/partner-system-repair.sql
-- declare `payment_status text not null default 'pending'` with NO check, beside
-- `approved_for_payout_at`, `commission_paid_at` and `reversed_at`. Those three
-- timestamps only make sense if this column is the lifecycle. The narrow CHECK
-- appears in no repository file. It is production-only drift — the same class as
-- ledger F-011 — and the repository's declaration is the authoritative statement
-- of intent.
--
-- `payout_status` (CHECK 'unpaid'/'paid'/'void') already exists and is written by
-- nothing. It is left alone here: converging the two is a real change to money
-- code and is recorded as a follow-up, not smuggled into a constraint fix.
--
-- BLAST RADIUS. Widening a CHECK cannot invalidate an existing row, and there
-- are no rows. Nothing else references the constraint.
-- ===========================================================================

-- DROP BY RULE, NOT BY NAME.
--
-- A migration that drops one constraint by name does not remove a DUPLICATE of
-- the same rule created under a different name — and that is not hypothetical:
-- the browser harness carries `pc_ro_ps`, added by a parity script, enforcing
-- exactly the narrow rule this file exists to widen. Applying the by-name
-- version there widened one constraint, left the other in force, and every
-- commission still failed. It took a full purchase through the browser to see
-- it, because the by-name migration reported success.
--
-- Production currently has only `referral_orders_payment_status_check`, so this
-- loop removes exactly that one there. It is written this way so the file
-- cannot be defeated by a name it does not know about.
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
      -- Only the ones that would REFUSE an accrual. A constraint that already
      -- permits 'pending' is either this migration re-running or something
      -- deliberately wider, and neither should be destroyed.
      and pg_get_constraintdef(con.oid) not like '%''pending''%'
  loop
    raise notice 'dropping legacy payment_status constraint %', c.conname;
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
    -- the order behind it was refunded; kept for reporting
    'refunded',
    'partially_refunded'
  ]));

-- The default must be a value the constraint admits. Production's default is
-- 'paid', which would silently mark an accrual settled if a writer ever omitted
-- the column. The repository declares 'pending' and that is the safe direction:
-- a row that has to be cleared before it can be paid.
alter table public.referral_orders
  alter column payment_status set default 'pending';
