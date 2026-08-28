-- ===========================================================================
-- REF-03 / F3 — make "a refund is applied once" a DATABASE rule.
--
-- WHAT IS WRONG. Three refund effects hand money back to a customer:
--
--   points_ledger       'order_refund_reversal'        claw back earned points
--   points_ledger       'order_refund_points_restore'  return redeemed points
--   store_credit_ledger 'membership_redemption_refund' return store credit
--
-- Each is supposed to happen exactly once per order, and each enforces that by
-- SELECTing for its own row and INSERTing when it does not find one
-- (membership.ts ledgerRowExists, store-credit.ts's already-refunded read).
-- Read-then-insert is not exactly-once. It is a race with a window as wide as
-- the read.
--
-- AND THERE ARE TWO WRITERS BY DESIGN. processPaymentWebhook runs these in its
-- refund branch, and refund-effect-repair.ts (the half-hourly sweep) re-runs
-- exactly the same three effects for refunds whose side-effects did not
-- complete — it selects precisely on the ABSENCE these guards read. A refund
-- webhook that is slow, or one that arrives while a sweep tick is mid-flight,
-- has both writers reading "no row yet" and both inserting. The customer is
-- credited twice, the ledger is the only record, and nothing alerts: both
-- callers report success.
--
-- WHAT THIS DOES. One partial unique index per effect, so the second INSERT is
-- refused by Postgres with 23505 no matter how the two callers interleave. The
-- application side treats 23505 on these rows as "already applied" and returns
-- "wrote nothing" (membership.ts isDuplicateLedgerRow, store-credit.ts), which
-- is the same answer the existing guard gives — so the sweep still counts a
-- no-op rather than a repair, and never alerts on a refund that is correct.
--
-- PARTIAL, DELIBERATELY. Only these three reasons are constrained. Ordinary
-- ledger rows (grants, earns, redemptions, admin adjustments) legitimately
-- repeat per order and are untouched.
--
-- store_credit_ledger is keyed (order_id, user_id): refundStoreCreditForOrder
-- now writes ONE aggregated row per account per order rather than one per
-- redemption row, so this index can hold. See that function for why.
-- ===========================================================================

-- PRE-FLIGHT. A unique index cannot be created over existing duplicates, and
-- the duplicates that matter here are DOUBLE CREDITS — real money already
-- handed out. Deleting one automatically would be a balance change made by a
-- migration, so this stops instead and names the orders for reconciliation.
do $$
declare dupes int;
begin
  select count(*) into dupes from (
    select order_id, reason
    from public.points_ledger
    where order_id is not null
      and reason in ('order_refund_reversal', 'order_refund_points_restore')
    group by order_id, reason
    having count(*) > 1
  ) d;

  if dupes > 0 then
    raise exception
      'points_ledger has % (order_id, reason) group(s) with duplicate refund rows. '
      'These are double credits/debits that were already applied; reconcile them by hand '
      '(select order_id, reason, count(*) from public.points_ledger where reason in '
      '(''order_refund_reversal'',''order_refund_points_restore'') group by 1,2 having count(*) > 1) '
      'and re-run this file.', dupes;
  end if;
end $$;

do $$
declare dupes int;
begin
  select count(*) into dupes from (
    select order_id, user_id
    from public.store_credit_ledger
    where order_id is not null
      and reason = 'membership_redemption_refund'
    group by order_id, user_id
    having count(*) > 1
  ) d;

  if dupes > 0 then
    raise exception
      'store_credit_ledger has % (order_id, user_id) group(s) with duplicate refund rows. '
      'Reconcile them by hand and re-run this file.', dupes;
  end if;
end $$;

-- One reversal and one restore per order, forever.
create unique index if not exists idx_points_ledger_order_refund_once
  on public.points_ledger (order_id, reason)
  where order_id is not null
    and reason in ('order_refund_reversal', 'order_refund_points_restore');

-- One store-credit return per order per account, forever.
create unique index if not exists idx_store_credit_ledger_order_refund_once
  on public.store_credit_ledger (order_id, user_id)
  where order_id is not null
    and reason = 'membership_redemption_refund';
