-- =========================================================================
-- Clean up memberships created by a FAILED payment.
--
-- Background: startMembershipSignup used to write the customer_memberships row
-- unconditionally — a failed charge still produced a full record (tier,
-- started_at, renews_at, next_billing_at) with status 'past_due'. Those
-- accounts display as paid members that never paid.
--
-- IMPORTANT — what counts as "paid":
--   membership_billing_events stores LIFECYCLE events (cancellation, pause,
--   resume, skip, tier_change) with status = 'succeeded' and amount_cents = 0,
--   because the *operation* succeeded — not because money moved. An account
--   that only ever failed to pay and then cancelled therefore HAS succeeded
--   rows. Filtering on status alone gives a false all-clear.
--   A real payment is:  status = 'succeeded'
--                   AND amount_cents > 0
--                   AND event_type in ('intro_charge','first_month_remainder','renewal')
--   This mirrors PAID_EVENT_TYPES / isPaidBillingEvent in membership-billing.ts.
--
-- RUN THE DIAGNOSTICS FIRST. Read the output, confirm it matches what you
-- expect, and only then run the corrections. Nothing here deletes a successful
-- payment or a legitimately active membership.
-- =========================================================================


-- ── 1. DIAGNOSTIC — every membership row, unfiltered ────────────────────────
-- No guard at all: this is the ground truth of who the app thinks is a member.
-- Compare `real_payments` against `status` — any row with status <> 'free' and
-- real_payments = 0 is a false activation.
select
  cm.user_id,
  mt.name              as tier,
  cm.status,
  cm.billing_cycle,
  cm.started_at,
  cm.next_billing_at,
  cm.veyra_membership_id,
  (
    select count(*) from public.membership_billing_events be
    where be.user_id = cm.user_id
      and be.status = 'succeeded'
      and be.amount_cents > 0
      and be.event_type in ('intro_charge', 'first_month_remainder', 'renewal')
  )                    as real_payments,
  (
    select count(*) from public.membership_billing_events be
    where be.user_id = cm.user_id and be.status = 'succeeded'
  )                    as succeeded_events_incl_lifecycle
from public.customer_memberships cm
left join public.membership_tiers mt on mt.id = cm.tier_id
order by cm.updated_at desc;


-- ── 2. DIAGNOSTIC — unpaid membership "orders" polluting the Orders page ────
select order_id, order_number, customer_email, membership_cycle,
       payment_status, amount_paid, created_at
from public.orders
where order_type = 'membership'
  and payment_status in ('pending_payment', 'payment_failed', 'canceled', 'cancelled')
order by created_at desc;


-- ── 3. DIAGNOSTIC — every billing event, with a paid/lifecycle verdict ──────
select
  user_id, event_type, amount_cents, status, provider_charge_id, created_at,
  case
    when status = 'succeeded' and amount_cents > 0
         and event_type in ('intro_charge', 'first_month_remainder', 'renewal')
      then 'PAID'
    when status = 'succeeded' then 'lifecycle (no money)'
    else 'failed'
  end as verdict
from public.membership_billing_events
order by created_at desc
limit 50;


-- =========================================================================
-- CORRECTIONS — run only after reviewing the diagnostics above.
-- =========================================================================

-- 4. Remove memberships that never had a real payment.
--    Guarded three ways: no PAID billing event, not admin-comped (comps have
--    next_billing_at IS NULL), and no processor subscription id. A real paid
--    member can never match all three.
delete from public.customer_memberships cm
where not exists (
        select 1 from public.membership_billing_events be
        where be.user_id = cm.user_id
          and be.status = 'succeeded'
          and be.amount_cents > 0
          and be.event_type in ('intro_charge', 'first_month_remainder', 'renewal')
      )
  and cm.next_billing_at is not null
  and coalesce(cm.veyra_membership_id, '') = '';


-- 5. Retire the unpaid membership checkout attempts.
--    They are kept (not deleted) as an audit trail, but marked canceled so they
--    stop appearing as live "awaiting payment" orders. The app also filters
--    order_type='membership' out of the customer Orders page.
update public.orders
set payment_status = 'canceled',
    updated_at = now()
where order_type = 'membership'
  and payment_status = 'pending_payment'
  and paid_at is null;


-- 6. Strip store credit issued without a real membership payment.
--    Only touches membership-granted credit. Review the select before the
--    delete; anything granted for another reason is left alone.
-- select * from public.store_credit_ledger scl
-- where scl.reason like '%membership%'
--   and not exists (
--     select 1 from public.membership_billing_events be
--     where be.user_id = scl.user_id
--       and be.status = 'succeeded'
--       and be.amount_cents > 0
--       and be.event_type in ('intro_charge', 'first_month_remainder', 'renewal')
--   );


-- ── 7. VERIFY — both should return 0 ────────────────────────────────────────
-- Memberships with no real payment:
--   select count(*) from public.customer_memberships cm
--   where not exists (
--           select 1 from public.membership_billing_events be
--           where be.user_id = cm.user_id and be.status = 'succeeded'
--             and be.amount_cents > 0
--             and be.event_type in ('intro_charge','first_month_remainder','renewal'))
--     and cm.next_billing_at is not null;
--
-- Live unpaid membership orders:
--   select count(*) from public.orders
--   where order_type = 'membership' and payment_status = 'pending_payment';
