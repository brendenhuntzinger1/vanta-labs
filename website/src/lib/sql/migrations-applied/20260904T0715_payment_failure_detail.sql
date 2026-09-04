-- ============================================================================
-- VANTA LABS — A FAILED PAYMENT SAYS WHY
--
-- APPLIED TO PRODUCTION 2026-09-04 ~07:15 UTC via the Supabase migration API
-- (migration name `payment_failure_detail`), on the owner's instruction to
-- "store and display Veyra's actual decline/failure reason" and to "separate
-- true processor declines from abandoned/expired checkout sessions". Safe to
-- re-run: every statement is idempotent and every UPDATE is filtered on
-- payment_status = 'payment_failed'.
--
-- Source of truth: ../payment-failure-detail.sql (this file is the record of
-- what ran; edit that one). The local harness applies it from
-- scripts/setup-local-harness.sh's post-parity list.
--
-- WHAT IT ADDS. Four nullable columns on public.orders:
--
--   payment_failure_kind    processor_declined | checkout_expired | other
--                           (CHECK constraint orders_payment_failure_kind_check)
--   payment_failure_code    the processor's machine code, when it sent one
--   payment_failure_reason  the processor's own message, or this system's
--                           plain-English account of why the row was retired
--   payment_failed_at       when the failure was recorded
--
-- payment_status is unchanged and no new status value exists. The three paths
-- that already write payment_failed now write the kind and reason beside it:
-- payment-webhook.ts (payment.failed / charge.failed), the express Apple Pay
-- lane (answered_no), and express-reconcile.ts (a dead session: failed is a
-- decline; expired / canceled is an abandoned checkout).
--
-- WHAT THE BACKFILL DID, ON THE FOUR ROWS THAT WERE payment_failed:
--
--   VL-BD9AE9EB  processor_declined  express_checkout_intents recorded Veyra's
--                                     verdict `answered_no` for this order.
--   VL-71BC8FDF  other               retired by the reconcile sweep after Veyra
--                                     reported the session closed; the exact
--                                     status was not recorded at the time.
--   VL-0716175A  checkout_expired    } retired BY HAND on 2026-08-26 after >24h
--   VL-9D8CA974  checkout_expired    } unpaid, no processor event ever received
--                                     (docs/superpowers/plans/2026-08-26-retire-
--                                     abandoned-pending-orders.md). These two
--                                     were corrected by order number in a
--                                     separate guarded UPDATE after this ran,
--                                     because a migration should not name
--                                     generated ids.
--
-- Verified after applying (read-only):
--
--   select payment_status, payment_failure_kind, count(*) from orders group by 1, 2;
--     canceled        NULL                5
--     paid            NULL               11
--     payment_failed  checkout_expired    2
--     payment_failed  other               1
--     payment_failed  processor_declined  1
--     pending_payment NULL                6
--
-- No paid, pending, canceled or refunded row was touched.
-- ============================================================================

alter table public.orders
  add column if not exists payment_failure_kind text,
  add column if not exists payment_failure_code text,
  add column if not exists payment_failure_reason text,
  add column if not exists payment_failed_at timestamptz;

comment on column public.orders.payment_failure_kind is
  'Why a payment_failed row failed: processor_declined (bank/processor said no), checkout_expired (session expired or cancelled without a charge attempt), other. NULL on rows written before 2026-09-04 or on non-failed rows.';
comment on column public.orders.payment_failure_code is
  'The processor''s machine-readable code for the failure (decline code, session status), when it sent one.';
comment on column public.orders.payment_failure_reason is
  'Human-readable reason: the processor''s own message when available, otherwise this system''s account of why the row was retired. Shown verbatim in the admin.';
comment on column public.orders.payment_failed_at is
  'When the failure was recorded by the webhook, the express lane or the reconcile sweep.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_failure_kind_check') then
    alter table public.orders
      add constraint orders_payment_failure_kind_check
      check (payment_failure_kind is null or payment_failure_kind in ('processor_declined', 'checkout_expired', 'other'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.express_checkout_intents') is not null then
    update public.orders o
       set payment_failure_kind   = 'processor_declined',
           payment_failure_reason = 'The processor declined this Apple Pay charge at authorisation. (Recorded before decline reasons were captured, 2026-09-04.)',
           payment_failed_at      = coalesce(o.payment_failed_at, o.updated_at)
      from public.express_checkout_intents i
     where i.order_id = o.order_id
       and i.outcome->>'outcome' = 'answered_no'
       and o.payment_status = 'payment_failed'
       and o.payment_failure_kind is null;
  end if;
end $$;

update public.orders
   set payment_failure_kind   = 'other',
       payment_failure_reason = 'Recorded before failure reasons were captured (2026-09-04). The processor closed this checkout session without a charge; the bank was never asked, or its answer was not kept.',
       payment_failed_at      = coalesce(payment_failed_at, updated_at)
 where payment_status = 'payment_failed'
   and payment_failure_kind is null;
