-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- WHY A FAILED PAYMENT NEEDS MORE THAN ONE WORD.
--
-- Until 2026-09-04 every unpaid outcome was written as the bare status
-- `payment_failed`. On the admin orders list that one word covered three
-- different things:
--
--   * the bank or processor said NO to a real charge attempt;
--   * the shopper walked away and Veyra later expired the checkout session,
--     which the reconcile sweep retires as payment_failed because the money
--     never moved (express-reconcile.ts, DEAD_SESSION_STATUSES);
--   * two abandoned test checkouts an operator retired by hand on 2026-08-26.
--
-- The operator read the list as "a lot of failed payments" and reasonably
-- asked whether the store was broken. It was not — and nothing in the row
-- could say so. Nor could anything say that every real customer with a failed
-- row had paid on a second order within two minutes.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT. Four nullable columns on
-- orders, written ONLY by the paths that already write payment_failed:
--
--   payment_failure_kind    processor_declined | checkout_expired | other
--   payment_failure_code    the processor's machine code (insufficient_funds,
--                           do_not_honor, expired, ...) when it sent one
--   payment_failure_reason  the processor's own message, or this system's
--                           plain-English account of why the row was retired
--   payment_failed_at       when the failure was recorded
--
-- payment_status itself is NOT changed and no new status value is introduced.
-- `payment_failed` is read by the terminal-state guards in payment-webhook.ts
-- and submit-payment, by the reconcile sweep, by profit/BXGY/offers SQL and by
-- the customer order-status poll; a new status value would have to be taught
-- to every one of them. A kind column beside the status carries the same
-- information with none of that blast radius, and a row with no kind renders
-- exactly as it did before.
--
-- NOTHING HERE CAN TOUCH A PAID ORDER. The columns are additive and nullable,
-- and every UPDATE below is filtered on payment_status = 'payment_failed'.

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

-- A closed vocabulary. Adding a fourth kind is a deliberate decision that
-- edits this constraint and payment-failure.ts together.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_failure_kind_check') then
    alter table public.orders
      add constraint orders_payment_failure_kind_check
      check (payment_failure_kind is null or payment_failure_kind in ('processor_declined', 'checkout_expired', 'other'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- BACKFILL — evidence-driven, and only where the row already reads
-- payment_failed. Rows that were paid, refunded, cancelled or still pending are
-- untouched by construction.
-- ----------------------------------------------------------------------------

-- 1. Apple Pay declines. The express lane records Veyra's verdict on the intent
--    row (`outcome.outcome = 'answered_no'`), so these are known declines even
--    though the decline reason itself was not captured before this change.
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

-- 2. Everything else that was already payment_failed. These rows were retired
--    either by the reconcile sweep, after the processor reported the checkout
--    session closed without a charge, or by hand. The exact processor status
--    was not recorded at the time, so the honest label is "other" with a
--    reason that says exactly that. (Rows retired by hand with documentary
--    evidence are corrected separately, by order number, outside this file.)
update public.orders
   set payment_failure_kind   = 'other',
       payment_failure_reason = 'Recorded before failure reasons were captured (2026-09-04). The processor closed this checkout session without a charge; the bank was never asked, or its answer was not kept.',
       payment_failed_at      = coalesce(payment_failed_at, updated_at)
 where payment_status = 'payment_failed'
   and payment_failure_kind is null;

-- Verify: every payment_failed row now carries a kind, and no other row does.
--   select payment_status, payment_failure_kind, count(*)
--     from public.orders group by 1, 2 order by 1, 2;
