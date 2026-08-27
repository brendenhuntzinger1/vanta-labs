# CHECKOUT / PAYMENT LANE — CERTIFICATION

**Date:** 2026-08-26 · **Scope:** checkout and payment reliability only.
Admin, financial/data integrity and the broader site belong to other sessions
and were not modified.

**Harness:** production build (`harness:build`/`harness:start`),
`PAYMENT_PROVIDER=live`, `VEYRA_API_BASE` pointed at a local stub, local
Postgres 16 + `pgrst-shim`. **No real processor was contacted and nothing was
written to production** except the two order rows retired earlier at the
operator's explicit instruction. Production reads were read-only.

**Suite:** 261 files passed, 9 skipped (270). **4180 tests passed**, 78 skipped
(4258). `tsc --noEmit` clean. Lint 0 errors, 43 warnings (42 pre-existing, 1 new
matching the codebase's existing `_unused` test-mock convention).

---

## Correction to the previous findings document

`CHECKOUT-AUDIT-2026-08-26.md` states that no `payment.failed` has ever been
recorded and that declines are invisible to the store. **That is wrong.**
Production `payment_events` contains `vtxn_a4485b87dd204a8a83f97ae4`, status
`payment_failed`, on order `VL-49CA32C1`, 2026-08-03 10:29 — followed by a
success on the same order at 10:30.

The earlier claim was based on the three incident orders (which have no events at
all) plus an inference. Grouping the whole table disproves it. Veyra **does**
send decline webhooks and this integration **does** record them.

What remains true: the three orders from the 2026-08-26 incident produced no
processor event of any kind.

---

## 1. Veyra event behaviour — from evidence only

| Event | What the integration accepts | What production has actually seen |
|---|---|---|
| Approval | `payment.succeeded`, `charge.succeeded` | **6 events**, latest 2026-08-25 |
| Decline | `payment.failed`, `payment_failed`, `charge.failed` | **1 event** (`vtxn_…`), 2026-08-03 |
| Cancel | `payment.canceled`, `charge.canceled` | none observed |
| Refund | `refund.completed`, `charge.refunded` | none observed |
| Chargeback | `chargeback.*`, `dispute.*` | none observed |
| Processor error | no distinct type | none observed |
| Timeout | no event — client-side `AbortSignal.timeout(15_000)` on session creation | n/a |
| Abandoned payment | **no event at all** | the 2026-08-26 incident, 3 orders |
| Duplicate callback | deduped by `event_id`, then by the `paid_side_effects_at` claim | proven under 5-way concurrency |

**How the server learns a payment failed, and whether that is reliable.**
Two mechanisms, in order:

1. **A decline webhook.** Proven to work — the Aug 3 event flipped the order to
   `payment_failed`. Reliable *when it arrives*.
2. **`reconcileVeyraPendingPayments`** polls the processor every 30 minutes for
   unpaid orders and retires sessions the processor reports as
   `failed|expired|canceled|cancelled`.

**The hole between them:** if the shopper never submits a card, neither fires.
Veyra sends nothing and the session stays `open`, so the order sits
`pending_payment` indefinitely. That is exactly the 2026-08-26 shape, and it is
why the new repeated-failure alert counts *unpaid orders* rather than
*failed payments*.

**NOT VERIFIED — needs Veyra:** whether Veyra emits a decline for every declined
authorisation or only some; whether it emits anything for a processor-side error
or a shopper abandoning at the card form; the exact type strings it uses.

**Observability defect found (unfixed):** `payment_events` stores only the
*mapped* status, never the raw provider event type. Three production events
mapped to the `pending_payment` default — meaning this integration did not
recognise their type — and what Veyra actually sent is now unrecoverable. An
unrecognised event is also absorbed silently (`payment-webhook.ts:1380`): no
alert, no log of the type. **Recommended:** record the raw `type` alongside the
mapped status, and alert once when an unrecognised money event arrives.

---

## 2. Decline handling — hardened

Re-reviewed cold, then proven on a production build in live mode.

| Requirement | Verdict | Evidence |
|---|---|---|
| Decline stops polling | **PASS** | 1 request, still 1 after 8s (would be 4 if polling) |
| Clear actionable message | **PASS** | browser-proven text |
| Explicitly told not charged | **PASS** | "your card has not been charged" |
| Retry possible | **PASS** | fresh attempt creates a distinct order |
| Reservation releases | **PASS** | `status = released` after decline |
| No duplicate order/payment on retry | **PASS** | same `idempotencyKey` → one order |
| Success never shows decline | **PASS** | paid order redirects to confirmation |
| Decline never overwrites paid | **PASS** | late `payment.failed` on a paid order left it `paid` |
| Out-of-order events | **PASS** | decline→success promotes to paid, stock still exact |
| Refresh after decline | **PASS** | page re-polls, shows decline, does not re-charge |

**Regression tests:** 28 across `checkout-poll-decision.test.ts` and
`checkout-decline-journey.test.ts`, covering every transition as a *sequence*.

**Mutation controls (RED→GREEN):**

| Mutation | Result |
|---|---|
| Restore the original defect (read only `paid`) | **8 RED** |
| Treat anything not-`pending:true` as terminal | **5 RED** |
| Accept truthy `paid` instead of strict `true` | **2 RED** |
| Restored | **28 GREEN**, clean diff |

**One nuance worth stating.** Server-side, a success arriving *after* a decline
correctly promotes the order to `paid` — a genuine late capture must be honoured.
Stock stayed exact through it (reconciled 25 − 3 paid = 22). The page does not
flip under a shopper who has already been told it failed; their retry carries
them forward instead.

---

## 3. Abandoned checkout — investigated, smaller blast radius than believed

| Question | Answer | Evidence |
|---|---|---|
| How long is inventory reserved? | 15 min | `DEFAULT_RESERVATION_MINUTES` |
| When does it release? | `expire_stale_reservations`, cron every 30 min — so ≤45 min worst case | `vercel.json`, production function |
| What happens to the order? | Stays `pending_payment` **for ever** | nothing retires it |
| Does it pollute Admin? | **No.** The default `"active"` view explicitly excludes `pending_payment` | `admin-orders.ts:78` |
| Revenue / AOV? | **No.** `REVENUE_ORDER_STATUSES` = paid/completed/succeeded + partially_refunded | `ledger.ts:42` |
| Order counts? | Counted separately and labelled distinctly as pending | `admin-revenue.ts:67-73` |
| Cleanup automatic? | Reservations yes; orders no | — |
| Can cleanup touch a paid order? | **No** — the function excludes orders in `('paid','partially_refunded')` | production `expire_stale_reservations` |

**Verdict:** the defect is real but narrow — unbounded row growth, not stock
loss, not revenue distortion, not Admin noise. The auto-retire fix is fully
specified in
`docs/superpowers/plans/2026-08-26-retire-abandoned-pending-orders.md` (Task 1)
and is **deliberately not shipped in this session**: it changes payment-status
logic and deserves its own focused pass rather than being rushed at the end of a
long one. The alert that made it visible is already fixed and throttled.

---

## 4. Repeated-failure alerting — shipped

Counts one shopper's **unpaid orders** in the last hour, not failed payments —
counting failures would not have caught the incident, which produced none.

- Threshold 3 (two is a retry, three is a pattern)
- Throttled to once per 6h against the last persisted alert, fails open
- Alert carries a 12-hex hash of the email plus order numbers — **no email,
  name, address, or anything about the card**
- Deferred with `after()`, non-throwing, cannot sit between a shopper and the
  card form

**Proven end to end:** three attempts → exactly one alert, context
`{"shopper":"d58f47a1c9a3","attempts":3,"orderNumbers":[…],"windowMinutes":60}`.

**Mutation controls:** threshold 1 → 2 RED; throttle removed → 1 RED; email
leaked into context → 1 RED; unpaid-only filter dropped → 1 RED. 11 GREEN on
restore.

---

## 5. Harness architecture — H-04 solved with no production change

The mock lockout is constant-folded at build time, so `harness-server.mjs`
cannot re-open it. **The lockout was not touched.**

Instead: `PAYMENT_PROVIDER=live` + `VEYRA_API_BASE` → local stub. Both the live
provider and the express service read that env var, so the genuine code path runs
and no real processor is reached. Payment outcomes are driven by signed webhooks
through the real handler.

This gets the full loop — **checkout UI → order → payment outcome →
success/decline UI** — on a production build with every protection intact.
`BROWSER-TESTING-RUNBOOK.md` updated with this, plus the `.env.test.local` trap
and the `unstable_cache` caching-failures trap.

Still not reachable locally: the real card iframe. `SCRIPT_SRC` is hardcoded to
veyragate.com and **should stay hardcoded** — an env-configurable script src on a
payment page is a way to point the card form at an arbitrary script.

---

## 6. Pricing, fees and concurrency — independent oracle

Expected money computed from published unit prices and stated rules, never read
back from the application.

| Case | subtotal | ship | protection | fee | total | Independent check |
|---|---|---|---|---|---|---|
| qty 1 | 69.00 | 15.00 | 0.00 | 2.52 | **86.52** | 84.00 × 3% = 2.52 ✓ |
| qty 2 | 131.10 | 15.00 | 0.00 | 4.38 | **150.48** | 138 × 0.95 = 131.10; 146.10 × 3% = 4.383→4.38 ✓ |
| qty 3 | 190.44 | 15.00 | 0.00 | 6.16 | **211.60** | 207 × 0.92 = 190.44; 205.44 × 3% = 6.1632→6.16 ✓ |
| qty 1 + protection | 69.00 | 15.00 | 2.76 | 2.60 | **89.36** | prot 4% = 2.76; 86.76 × 3% = 2.6028→2.60 ✓ |
| qty 3 + protection | 190.44 | 15.00 | 7.62 | 6.39 | **219.45** | prot 4% = 7.6176→7.62; 213.06 × 3% = 6.3918→6.39 ✓ |
| qty 5 (≥ $200) | 303.60 | **0.00** | 0.00 | 9.11 | **312.71** | 345 × 0.88 = 303.60; free ship; × 3% = 9.108→9.11 ✓ |

Every line matches to the cent. Confirmed: bundle tiers 5/8/12%, free shipping
at ≥ $200, protection 4% of subtotal **and included in the fee base**, card fee
3% of (subtotal + shipping + protection), half-up rounding throughout, tax $0
(no nexus states configured).

**Concurrency**

| Case | Result |
|---|---|
| 8 simultaneous checkouts, 1 unit of stock | **1 succeeded, 7 refused** — "10mg just sold out". One hold, qty 1. No oversell. |
| 5 concurrent distinct `payment.succeeded` on one order | all return paid; side-effect claim spent once; **stock decremented exactly once** (10→9) |
| Duplicate submit (same `idempotencyKey`) | one order |
| Duplicate payment on a paid order | refused, stock unchanged |

---

## 7. Overlapping findings from the other inspection

| # | Finding | Verdict |
|---|---|---|
| 1 | Card/service fee naming consistent | **PASS** — one label, `cardFeeConfig?.label ?? "Card processing fee"`, with the percentage shown |
| 2 | Card fee never mislabeled as shipping protection | **PASS** — separate lines, separate columns (`card_processing_fee` vs `shipping_protection_fee`) |
| 3 | Declining protection ⇒ $0 everywhere | **PASS** — `prot = 0.00` on every non-protection order |
| 4 | Cart must not say "Final total" | **WAS REAL — FIXED.** Cart said "Final total" two lines below "Sales tax — Calculated at checkout", and excluded the mandatory 3% fee: an $84.00 cart became an $86.52 charge. Now "Estimated total" with a "Processing fee — Calculated at checkout" line. |
| 5 | Cart clears after successful checkout | **PASS — no defect.** `ClearCartOnMount` is mounted on order-confirmation and clears only after a completed order, deliberately preserving the cart for an abandoned or declined payment. Exactly what retry-after-decline needs. |
| 6 | Coupon UI must not claim a discount when a promotion won | **REAL — left alone.** `cart-context.tsx:1200` sets `"Coupon applied."` unconditionally on a valid code, even when a better automatic promotion keeps winning and the total does not move. Owned by the other inspection; mechanism documented, code untouched. |
| 7 | BAC-water upsell resolves the live slug | **PASS** — production has exactly one `bacteriostatic-water`, published, active, 38 units; matches `BAC_WATER_SLUG` |
| 8 | Apple Pay advertising vs eligibility | **NOT VERIFIED** — gating reads `apple_pay_enabled` from the processor, which is the right mechanism, but the card method advertises "Apple Pay" unconditionally and whether the wallet appears inside the Veyra iframe cannot be checked without Apple hardware |

---

## CERTIFICATION

| Area | Verdict |
|---|---|
| **CHECKOUT CORE** | **PASS** |
| **SUCCESSFUL PAYMENT** | **PASS** |
| **DECLINED PAYMENT** | **PASS** |
| **INVENTORY RESERVATION + RELEASE** | **PASS** |
| **DUPLICATE PAYMENT / IDEMPOTENCY** | **PASS** |
| **PRICING / FEES / DISCOUNTS** | **PASS** |
| **ABANDONED CHECKOUT** | **PASS** (with a known, scoped, unshipped improvement — §3) |
| **CONCURRENCY / OVERSELL** | **PASS** |
| **CUSTOMER ERROR EXPERIENCE** | **PASS** |
| **PAYMENT OBSERVABILITY** | **PASS** (raw event type not retained — §1) |
| **MOBILE CHECKOUT** | **NOT VERIFIED** |

Mobile is NOT VERIFIED rather than PASS: this pass spent its browser budget on
the decline/success loop, and no checkout screen was re-checked at 390×844 after
the cart change. Nothing suggests a defect; it simply was not looked at.

## REMAINING EXTERNAL VERIFICATION

**Requires Veyra**
- Whether a decline webhook is emitted for *every* declined authorisation, or only some
- What is emitted for a processor-side error, a timeout, or a shopper abandoning at the card form
- The exact type strings behind the three unrecognised production events
- Whether Apple Pay is offered inside the hosted card iframe

**Requires Apple hardware**
- The Apple Pay wallet sheet, on Safari on a provisioned device. Chromium cannot produce one at any price.

**Requires a real browser against a real deployment**
- The live card iframe mounting and accepting input (`SCRIPT_SRC` is, correctly, hardcoded)
- Mobile checkout at 390×844 end to end

**Requires an operator decision**
- Shipping Task 1 of the retire-abandoned-orders plan
- Recording the raw provider event type in `payment_events`
