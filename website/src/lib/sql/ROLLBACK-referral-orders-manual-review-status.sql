-- Rollback for referral-orders-manual-review-status.sql: restore the
-- lifecycle constraint WITHOUT 'manual_review'.
--
-- WARNING. This re-breaks VL-7: any refund of an order whose commission was
-- already paid out will be refused with 23514 again. It also cannot run while
-- such a row exists — check first:
--
--   select count(*) from public.referral_orders where payment_status = 'manual_review';
--
-- Rows in that state must be reconciled to 'reversed'/'paid' by hand before
-- this file will apply.
alter table public.referral_orders
  drop constraint if exists referral_orders_payment_status_check;

alter table public.referral_orders
  add constraint referral_orders_payment_status_check
  check (payment_status = any (array[
    'pending',
    'approved_for_payout',
    'paid',
    'reversed',
    'voided',
    'refunded',
    'partially_refunded'
  ]));
