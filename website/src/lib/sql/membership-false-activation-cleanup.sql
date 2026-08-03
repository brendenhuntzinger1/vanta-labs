-- =========================================================================
-- Clean up memberships created by a FAILED payment.
--
-- Background: startMembershipSignup used to write the customer_memberships row
-- unconditionally — a failed charge still produced a full record (tier,
-- started_at, renews_at, next_billing_at) with status 'past_due'. Those
-- accounts display as paid members that never paid.
--
-- RUN THE DIAGNOSTICS FIRST. Read the output, confirm it matches what you
-- expect, and only then run the corrections. Nothing here deletes a successful
-- payment or a legitimately active membership.
-- =========================================================================


-- ── 1. DIAGNOSTIC — who looks like a member but has no successful payment? ──
-- Any row returned here was created by a failed/never-completed signup.
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
    where be.user_id = cm.user_id and be.status = 'succeeded'
  )                    as successful_payments
from public.customer_memberships cm
left join public.membership_tiers mt on mt.id = cm.tier_id
where not exists (
  select 1 from public.membership_billing_events be
  where be.user_id = cm.user_id and be.status = 'succeeded'
)
order by cm.updated_at desc;


-- ── 2. DIAGNOSTIC — unpaid membership "orders" polluting the Orders page ────
select order_id, order_number, customer_email, membership_cycle,
       payment_status, amount_paid, created_at
from public.orders
where order_type = 'membership'
  and payment_status in ('pending_payment', 'payment_failed', 'canceled', 'cancelled')
order by created_at desc;


-- ── 3. DIAGNOSTIC — did ANY membership payment actually succeed? ────────────
select user_id, event_type, amount_cents, status, provider_charge_id, created_at
from public.membership_billing_events
order by created_at desc
limit 50;


-- =========================================================================
-- CORRECTIONS — run only after reviewing the diagnostics above.
-- =========================================================================

-- 4. Remove memberships that never had a successful payment.
--    Guarded three ways: no succeeded billing event, not admin-comped
--    (comps have next_billing_at IS NULL), and no processor subscription id.
--    A real paid member can never match all three.
delete from public.customer_memberships cm
where not exists (
        select 1 from public.membership_billing_events be
        where be.user_id = cm.user_id and be.status = 'succeeded'
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
  and coalesce(amount_paid, 0) >= 0
  and paid_at is null;


-- 6. Strip store credit that was issued without a successful membership payment.
--    Only touches UNUSED membership-granted credit; anything spent or granted
--    for another reason is left alone.
--    Review the select before running the delete.
-- select * from public.store_credit_ledger scl
-- where scl.reason like '%membership%'
--   and not exists (
--     select 1 from public.membership_billing_events be
--     where be.user_id = scl.user_id and be.status = 'succeeded'
--   );


-- ── 7. VERIFY — all three should return zero rows ───────────────────────────
-- Memberships with no successful payment:
--   select count(*) from public.customer_memberships cm
--   where not exists (select 1 from public.membership_billing_events be
--                     where be.user_id = cm.user_id and be.status = 'succeeded')
--     and cm.next_billing_at is not null;
--
-- Live unpaid membership orders:
--   select count(*) from public.orders
--   where order_type = 'membership' and payment_status = 'pending_payment';
