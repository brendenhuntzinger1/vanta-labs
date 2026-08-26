-- Exact rollback for referral-orders-commission-lifecycle.sql.
--
-- Safe ONLY while no row holds a value outside the original three. Check first:
--
--   select payment_status, count(*) from public.referral_orders
--   where payment_status not in ('paid','refunded','partially_refunded')
--   group by 1;
--
-- If that returns rows, this rollback will fail — which is correct. Rolling back
-- would then mean deciding what happens to real accrued commissions, and that is
-- the owner's call, not a migration's.

alter table public.referral_orders
  drop constraint if exists referral_orders_payment_status_check;

alter table public.referral_orders
  add constraint referral_orders_payment_status_check
  check (payment_status = any (array['paid','refunded','partially_refunded']));

alter table public.referral_orders
  alter column payment_status set default 'paid';
