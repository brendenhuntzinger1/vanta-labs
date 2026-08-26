# Checkout lane — focused follow-ups

Deliberately **not** on the certification branch. Each is scoped, evidenced, and
independently shippable. Neither is a P0 or P1: the certification pass proved the
lane is correct and observable without them.

---

## FU-1 — Retire abandoned `pending_payment` orders

**Status:** designed, specified, unshipped.
**Plan:** `docs/superpowers/plans/2026-08-26-retire-abandoned-pending-orders.md`, Task 1.

**The defect.** `reconcileVeyraPendingPayments` has three outcomes — settle,
retire-if-dead, poll again — and no terminal state for an abandoned checkout. So
`pending_payment` rows accumulate without bound.

**Blast radius, measured (not assumed).** Smaller than it first looked:

| | |
|---|---|
| Admin default view | **Unaffected** — `"active"` excludes `pending_payment` (`admin-orders.ts:78`) |
| Revenue / AOV | **Unaffected** — `REVENUE_ORDER_STATUSES` is paid/completed/succeeded + partially_refunded (`ledger.ts:42`) |
| Order counts | Counted separately and labelled distinctly (`admin-revenue.ts:67-73`) |
| Inventory | Released within ~45 min worst case (15 min hold + 30 min sweep) |
| Paid orders | **Cannot** be touched by cleanup — `expire_stale_reservations` excludes `('paid','partially_refunded')` |

So the harm is row growth, not money and not stock.

**Why it is not in this branch.** It changes payment-status logic — the one thing
in this lane that decides whether a customer's order is alive. That deserves its
own focused pass with its own review, not the tail of a long session.

**Shape of the fix.** Split the current catch-all bucket in two: the processor
*affirmatively* reporting an uncaptured session (`open`/`processing`/
`requires_action`) is evidence enough to retire after 24h; a session that cannot
be read is **never** retired at any age, because that is the shape of a charged
card whose webhook was lost.

---

## FU-2 — Record the raw provider event type in `payment_events`

**Status:** identified, unshipped. Requires a schema change.

**The defect.** `payment_events` stores only the *mapped* status, never the raw
type Veyra sent (`payment-webhook.ts:363-422`). An unrecognised event is also
absorbed silently at `payment-webhook.ts:1380` — no alert, no log of the type.

**Evidence it matters.** Three production events mapped to the `pending_payment`
default, meaning this integration did not recognise their type. What Veyra
actually sent is now unrecoverable, which is exactly the question the
certification could not answer.

**Shape of the fix.**
1. Add a nullable `provider_event_type text` column to `payment_events`.
2. Write `eventPayload.type` into it on every insert/upsert path.
3. Raise one throttled `warning` when `isRecognisedMoneyEvent` is false, carrying
   the raw type — so the next unknown event names itself instead of vanishing.

**Why it is not in this branch.** A production schema migration, and this branch
deliberately contains none.

---

## Not ours: coupon messaging

`cart-context.tsx:1260` sets `"Coupon applied."` unconditionally on any valid
code, even when a better automatic promotion keeps winning and the total does not
move — so the shopper is told their code worked while nothing changes.

Verified still present on `claude/vanta-labs-live-inspection-h1eh4f`, which is
**actively editing that file** (83 insertions). Owned there. Documented here only
so it is not lost; do not fix it from this lane.
