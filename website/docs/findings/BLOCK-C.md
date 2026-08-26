# Block C — Email

Session branch: `claude/block-ab-audit-zuuyuz` (reassigned to block C mid-session).
Scope: `src/lib/email/**`, `email/templates`, `retry-queue.ts`, and the email
call sites in other files (recorded CROSS-BLOCK per Rule 3, not edited).

**No real email was sent at any point.** Every test in this block mocks
`@/lib/email/send`; nothing reached a provider.

---

## C-01 — Approval email quotes a rate from the non-authoritative table and ignores the rate set in the same request

| | |
|---|---|
| **Historical defect** | #3 (0% commission approval email) |
| **Severity** | P0 |
| **Evidence grade** | A — reproduced by test against the real `updatePartnerStatus` |
| **Status** | `CONFIRMED — FIX BLOCKED (CROSS-BLOCK)` |
| **Regression test** | `website/src/lib/approval-email-commission-rate.test.ts` (currently RED, by design — see below) |

### Reproduction

`npx vitest run src/lib/approval-email-commission-rate.test.ts`

The test drives the real `updatePartnerStatus` with the documented drift shape —
`partners.commission_percent = "10.00"`, `ambassadors.commission_percent =
"25.00"`, applicant `pending` — and reads the percentage out of the approval
email that comes back. Four assertions fail, all landing on the same wrong value:

| Scenario | Ambassador is told | Truth |
|---|---|---|
| Approve **and type 20** into the commission field in one submission | **10%** | 20% (written to both tables by this same request) |
| Approve with no rate typed | **10%** | 25% (`ambassadors`, what checkout pays) |
| Approve with an explicit **0%** | **10%** | 0% |
| Approve with both columns NULL, program default 12 | 12% | 12% ✅ (passes) |
| Rate edit that is not a status transition | no email ✅ | no email |

### Root cause

`src/lib/partner-portal.ts` — `updatePartnerStatus`:

1. Line ~1460: the partner row is read from **`partners`**, selecting
   `commission_percent`, **before** any write.
2. Lines ~1590-1605: `updatePayload` (including `commission_percent` from
   `input.commissionPercent`) is written to `ambassadors` first, then `partners`.
   The code's own comment calls `ambassadors` authoritative — "ambassadors is
   what checkout reads" — and `partners` "the mirror" / "a display copy".
3. Line ~1625: the email is sent with
   `commissionPercent: existingPartner.commission_percent` — the **mirror**
   value, read **before** the update. `input.commissionPercent` is never passed.

So the email is wrong in two independent ways at once: wrong table, and stale by
one write. `sendPartnerStatusEmail` then does
`input.commissionPercent ?? referralProgram?.defaultCommissionPercent`, and
`ambassadorApprovedTemplate` (`templates.ts:566`) applies a final hard-coded
`10` — reachable only when `getReferralProgramConfig()` throws, since that call
is wrapped in `.catch(() => null)`.

Thirty lines below, `sendReferralCodeAssignedEmail` resolves the same value
**correctly**, via `firstFinitePercent([request, stored, programDefault])`. The
two emails are sent from the same function, in the same admin action, and can
quote different numbers to the same person. The comment at `partner-portal.ts:251`
asserts the approval email "resolves it inside `sendPartnerStatusEmail` ... for
the same reason" — that assertion is false, and it is what let the defect survive
the MIZZY fix.

### Fix

`CROSS-BLOCK: src/lib/partner-portal.ts — updatePartnerStatus / sendPartnerStatusEmail.`
Block A+B owns this file (Rule 3, earlier letter wins), so it is **not edited
here**. The change:

1. Read `commission_percent` from **`ambassadors`**, not `partners`, or better:
   move the read **after** the write so it reflects what was just committed.
2. Pass the resolution chain through the existing shared resolver rather than a
   single value:
   `firstFinitePercent([input.commissionPercent, ambassadorsStored, partnersStored, programDefault])`.
   `firstFinitePercent` already handles the two traps here — `numeric(5,2)`
   arriving as the string `"15.00"`, and a deliberate `0` surviving instead of
   being read as absence.
3. Delete the false comment at `:251` or make it true.
4. `templates.ts:566`'s hard-coded `10` (and `20`/`10`/`14` beside it) should
   render nothing rather than invent a number when the program config is
   unavailable — a wrong rate in writing is worse than an omitted one.

Once (1)+(2) land, all six assertions in the regression test pass unchanged.

### Why the test is committed RED

The proof of a P0 is the failing test. It is not skipped, `.todo`'d or inverted,
because either of those would hide the defect from the consolidation run. Block M
should expect **4 failures in this file** until block A+B lands the fix, and
should treat them turning green as the acceptance criterion.

### Negative controls (both pass today, and must keep passing)

- A commission edit that is **not** a status transition sends no approval email
  (the `statusChanged` gate holds).
- The email writes **no** commission rate to either table — it cannot change what
  an ambassador is paid.

### Not affected

The **money** is not affected. Commission accrual resolves the rate through
`getEffectiveCommissionPercent` against `ambassadors.commission_percent` and does
not read the email path. This is a defect in what an ambassador is *told*, which
is a contractual and trust problem, not a payout arithmetic one.

### Open question for the owner (read-only, no production write)

Do `partners.commission_percent` and `ambassadors.commission_percent` currently
disagree for any live ambassador? The code names ELIJAH-AB78AE and MIZZY as drift
cases. Every disagreeing row is an ambassador who was emailed the wrong rate on
approval. Answering it needs a production read; it is not needed to confirm the
defect.

---

## C-02 — The retry sweep delivers a receipt without closing the send-once slot, so the customer gets a second one

| | |
|---|---|
| **Severity** | P0 |
| **Evidence grade** | A — reproduced by test, modelling the real partial unique index |
| **Status** | `CONFIRMED — FIX NEEDS OWNER APPROVAL (schema change, Rule 4)` |
| **Regression test** | `website/src/lib/email/order-email-sweep-duplicate.test.ts` (3 of 5 RED, by design) |

### Reproduction

`npx vitest run src/lib/email/order-email-sweep-duplicate.test.ts`

The test models `order_email_log` **with** its partial unique index
`(order_id, kind) where status in ('sending','sent')` and walks the real
sequence through the real `sendOrderEmailOnce`, `enqueueFailedEmail` and
`retryPendingEmails`:

1. Provider outage during the payment webhook → `order_email_log` row goes
   `failed`, the rendered payload is queued into `pending_emails`. ✅
2. Provider recovers; the 30-minute cron sweep drains the queue. **The customer
   now has their receipt.** ✅
3. `order_email_log` is still `failed`. ❌ *expected `['sent']`, got `['failed']`*
4. Any later caller — a redelivered webhook, an admin approving the same order,
   either `sendOrderEmailOnce` site — claims the released slot with no `23505`
   and sends again. ❌ *expected 1 delivered message, **got 2***

The two controls in the same file pass, and must keep passing: a second
*concurrent* send is still refused with `already_sent`, and the provider
idempotency key is still `order_confirmation:<orderId>` on the primary path.

### Root cause

`src/lib/email/retry-queue.ts:52-63`. `retryPendingEmails()` calls `sendEmail()`
with no `idempotencyKey`, no order id, and neither reads nor writes
`order_email_log`. `retryPendingEmailsForOrder()` (:127) is identical in this
respect.

The design intent is stated in `order-email-once.ts` and is individually sound:

> A FAILED SEND RELEASES THE SLOT. 'failed' rows fall outside the partial unique
> index, so a genuine retry (the pending_emails sweep, or a later webhook) can
> still get the receipt out.

Releasing the slot is correct **only if whoever completes the retry closes it
again**. The sweep is named as one of the two retry mechanisms and does not.
So the guarantee is one-way: it stops two callers racing in the same instant, and
does not stop sweep-then-replay. `order-email-once.ts`'s claim that the index
"makes a duplicate impossible regardless of who asks" is false for exactly this
path — and because Resend's `Idempotency-Key` is also absent on the sweep, even a
provider that would collapse the duplicate cannot.

Two further consequences fall out of the same gap:

- **The record is wrong even when nothing duplicates.** An order whose receipt
  the sweep delivered reads `failed` forever. That is the artefact
  `order-email-once.ts` exists to produce ("it cannot settle a chargeback").
- **`retryPendingEmailsForOrder`** re-sends every queued mail matching
  `subject ilike '%<orderNumber>%'`, up to 20 rows — confirmation, shipping,
  delivery and refund together — on one operator click. See C-08.

### Fix

Two parts. The code change is small; it depends on the schema change.

1. **Schema (needs owner approval — Rule 4).**
   `website/src/lib/sql/PROPOSED-pending-emails-order-link.sql`, written but
   **not applied**: nullable `order_id` and `email_kind` columns on
   `pending_emails`, plus a partial index. The existing comment defends
   `pending_emails` being self-contained — that argument applies to the subject
   and body, which stay self-contained; it does not require the order link to be
   absent. Nullable so shipping and marketing rows queue exactly as they do now.

2. **Code (`src/lib/email/retry-queue.ts`, block C's own file).**
   - `enqueueFailedEmail(message, error, context?)` accepts
     `{ orderId, kind }` and writes them; the three call sites that have an
     order (`payment-webhook.ts:1113`, `:1619`, `shippo/service.ts:1642`) pass
     it. Those are CROSS-BLOCK edits — one line each.
   - On success, the sweep passes `idempotencyKey: \`${kind}:${orderId}\`` when
     it has one, and updates the matching `order_email_log` row to `sent` with
     the provider message id — the same write `sendOrderEmailOnce` makes.
   - Rows with no order context behave exactly as they do today.

`CROSS-BLOCK: src/lib/payment-webhook.ts:1113 and :1619 — pass { orderId, kind } to enqueueFailedEmail so the sweep can close the send-once slot.`
`CROSS-BLOCK: src/lib/shippo/service.ts:1642 — same, for shipping/delivery mail.`

An alternative that needs no migration — have the sweep match `order_email_log`
by subject text — is the fragile join C-08 is a finding **about**, and is not
recommended.

### Why the test is committed RED

Same reason as C-01: the failing assertion is the evidence. Block M should expect
**3 failures in this file** until the migration is approved and the write-back
lands.

### Open questions for the owner (production reads only)

- Are there live `pending_emails` rows with `status='failed'`? Each is a customer
  who never received a receipt or shipping notice; the only alert raised was
  severity `warning` (admin-panel only, no email).
- Are there `order_email_log` rows at `status='failed'` whose orders did receive
  a receipt via the sweep? Those are the orders currently exposed to a duplicate
  on any webhook replay.

---

## C-03 — The admin order page's shipping-email branch is dead code, and picks the wrong template when it does fire

| | |
|---|---|
| **Severity** | P1 |
| **Evidence grade** | A — provable by inspection; the variable it reads is never assigned |
| **Status** | `CONFIRMED — CROSS-BLOCK (block I owns src/app/api/admin/**)` |

### Evidence

`src/app/api/admin/orders/[orderId]/route.ts:222`:

```ts
const newStatus = String(updatePayload.fulfillment_status ?? priorStatus);
...
const statusTransitioned = newStatus !== priorStatus && NOTIFY_STATUSES.has(newStatus.toLowerCase());
```

`updatePayload` is assigned in exactly two places in the whole file —
`payment_status` (:143) and `tracking_number` (:146). `fulfillment_status` is
never assigned, deliberately:

> `// fulfillment_status is DELIBERATELY not in this payload any more.`  (:132)

The status is now moved by `setOrderFulfillmentStatus()` (:162), which sends no
email. So `newStatus === priorStatus` **always**, `statusTransitioned` is
**always false**, and the only surviving trigger is `trackingAddedOrChanged`.

Two customer-visible consequences:

1. **An admin marking an order shipped or delivered from the order page emails
   nothing.** The status advances, `order_status_history` gains a row, the
   customer hears nothing. (The bulk "mark shipped" action on a different code
   path does still email — so the same operator intent notifies or does not
   depending on which screen it was expressed from.)
2. **When it does fire, it picks the template from the OLD status.**
   `newStatus.toLowerCase() === "delivered"` (:247) is testing `priorStatus`.
   Move an order to `delivered` while adding a tracking number and the customer
   gets the generic *"Shipping Update"*; add tracking to an already-`delivered`
   order and they get a second *"Delivered"* email.

The same block also reads the status from a second place — line 252 uses
`order.fulfillment_status`, re-fetched **after** the transition, so it holds the
**new** status. One email therefore chooses its template from the old status and
prints the new one in its body.

### Fix

`CROSS-BLOCK: src/app/api/admin/orders/[orderId]/route.ts:215-262 — take the status from the transition result, not from updatePayload.`
`setOrderFulfillmentStatus` already returns the transition; use its `to` value
for both `statusTransitioned` and the template choice. Better still, route the
decision through `notificationFor()` in `shippo/service.ts`, which is the
function that already owns "which email does this move earn" — see C-04.

---

## C-04 — Two shipping emails for one parcel: the admin path and the carrier scan do not know about each other

| | |
|---|---|
| **Severity** | P1 |
| **Evidence grade** | B — established by inspection across three call sites; not yet driven end to end |
| **Status** | `CONFIRMED — CROSS-BLOCK (blocks I and D)` |

### Evidence

Three independent code paths send `shippingUpdateTemplate`:

| Path | File | Consults `notificationFor()` | Records the send |
|---|---|---|---|
| Admin adds/changes a tracking number | `app/api/admin/orders/[orderId]/route.ts:262` | no | no |
| Admin bulk "mark shipped" | `lib/admin-orders.ts:288` | no | no |
| Carrier scan (Shippo webhook) | `lib/shippo/service.ts:1829` | **yes** | `shippo_webhook_events` |

`shippo/service.ts` reasons carefully about this — `IN_CARRIER_NETWORK` and
`notificationFor()` exist precisely so that "entering the carrier network is one
event no matter how many scans describe it". That reasoning covers Shippo events
against each other. It cannot cover the two admin paths, which never call it and
leave no trace for it to find.

The ordinary operator sequence — enter the tracking number in admin, then the
carrier's first TRANSIT scan arrives — sends **two** "Shipping Update" emails for
one parcel. `shippo_webhook_events` dedupes Shippo against Shippo; nothing
dedupes admin against Shippo.

### Fix

`CROSS-BLOCK: src/lib/shippo/service.ts — export a single sendShippingNotification(orderId, from, to, ctx) that consults notificationFor() AND records the send.`
`CROSS-BLOCK: src/app/api/admin/orders/[orderId]/route.ts:236-262 and src/lib/admin-orders.ts:288 — call it instead of rendering and sending directly.`

The recording half matters as much as the routing half: until an
admin-originated shipping email leaves a row somewhere, no later path can know it
happened. `order_email_log` already has the right shape — `OrderEmailKind` would
gain `shipping_update` / `delivery_confirmation` and these sends would go through
`sendOrderEmailOnce`, which is the mechanism the codebase already built for
exactly this question.

---

## C-05 — The refund email cannot be retried, cannot be deduped, and its failure leaves no trace at all

| | |
|---|---|
| **Severity** | P1 |
| **Evidence grade** | A — provable by inspection |
| **Status** | `CONFIRMED — CROSS-BLOCK (block A+B owns payment-webhook.ts)` |

### Evidence

`src/lib/payment-webhook.ts:1735-1750`:

```ts
// Best-effort — never block webhook processing; sendEmail queues/retries on failure.
if (orderRecord?.customer_email) {
  try {
    const refundEmail = refundConfirmationTemplate({ ... });
    await sendEmail({ to: String(orderRecord.customer_email), ...refundEmail });
  } catch (refundEmailError) {
    console.error("Unable to send refund confirmation email for order", orderId, refundEmailError);
  }
}
```

Three defects in sixteen lines:

1. **The comment is false.** `sendEmail` does not queue and does not retry —
   `src/lib/email/send.ts` calls the provider once and returns. Queueing is
   `enqueueFailedEmail`, which is imported in this very file (:7) and used for
   order confirmations (:1113, :1619) but **not here**.
2. **The `catch` is unreachable.** `sendEmail` is documented "Never throws" and
   its body wraps everything in try/catch, returning `{ success: false }`. So the
   `console.error` never runs, and the returned `EmailSendResult` is discarded
   without being read. A refund email that fails produces **no queue row, no log
   row, no console line, no alert** — nothing, anywhere.
3. **No dedupe.** `OrderEmailKind` already declares `"refund_confirmation"` and
   `sendOrderEmailOnce` already supports it — with **no caller**. A processor
   refund followed by a chargeback event, or any webhook replay that re-enters
   this branch, sends a second "Refund processed" notice.

A customer who is told their refund was processed, and one who is told twice,
are both worse off than the ledger suggests: this is the message people forward
to their bank.

### Fix

`CROSS-BLOCK: src/lib/payment-webhook.ts:1735-1750 — replace the raw sendEmail with sendOrderEmailOnce({ kind: "refund_confirmation" }), enqueueFailedEmail on failure, and delete the false comment.`

The declared-but-uncalled `refund_confirmation` kind means this is a three-line
change, not a design question. Note that it depends on C-02: until the sweep
closes the send-once slot, adding `refund_confirmation` to `order_email_log`
inherits the same one-way guarantee.

---

## C-06 — Every failed send mints another live, redeemable coupon

| | |
|---|---|
| **Severity** | P1 (money) |
| **Evidence grade** | A — reproduced by test |
| **Status** | `CONFIRMED — CROSS-BLOCK (cart-recovery.ts)` |
| **Regression test** | `website/src/lib/email/cart-recovery-coupon-leak.test.ts` (2 of 3 RED) |

### Reproduction

`npx vitest run src/lib/email/cart-recovery-coupon-leak.test.ts`

One abandoned cart, 25 hours old, t24h stage enabled:

| Provider | Sweeps | Coupons created | Emails delivered |
|---|---|---|---|
| working | 3 | **1** ✅ | 1 |
| failing | 3 | **3** ❌ | 0 |
| failing | 2 | **2** ❌ | 0 |

### Root cause

`cart-recovery.ts` already carries a fix for minting-per-sweep, with this comment:

> Mint a coupon only if this cart hasn't already had its t24h email — the sweep
> runs repeatedly, so minting before the send-dedup check (as this did)
> re-created a fresh SAVE-… code on every pass ... means each forgotten cart gets
> exactly one recovery code.

The guard (`hasSentStage`) reads `abandoned_cart_emails`. But
`reserveAndSendStage` **deletes its reservation row when the send fails**
(:214), "so a later sweep pass can retry" — and the mint happens *before* the
reservation. So on every failed send the guard is wiped and the next pass mints
again. The two fixes cancel each other out.

This is not an edge case. **Email is disabled by default** and `NoopEmailProvider`
returns `success: false`, so "the send fails" is the application's shipped state.
The sweep runs every 30 minutes and scans carts up to 96h old, so a single
abandoned cart with email off produces on the order of **140 live coupon rows** —
each `active: true`, `discount_type: 'percent'`, `max_redemptions: 1`,
`assigned_email` set to a real shopper. They are redeemable.

### The wider defect underneath it

`NoopEmailProvider` reporting `success: false` makes "email is off" indistinguishable
from "the provider rejected it", and two comments in the codebase say otherwise:

- `email/provider.ts:12` — "Email is DISABLED by default ... so nothing is sent
  and **no email-triggering action ever fails**". Every caller sees a failure.
- `email/providers/noop.ts:3` — "Used when EMAIL_PROVIDER is set to an
  unrecognized value". It is also the default path for the entire application.

Three dedupe stores are poisoned by that single result, this being the worst:

1. **Cart recovery** — reservation rolled back, coupon re-minted (above).
2. **Order confirmations** — every one enqueues to `pending_emails`, burns five
   attempts over ~2h of sweeps, then raises an `email_undeliverable` alert of
   severity `warning` (admin-panel only, no email — and it could not send one).
3. **Automations** — `sendMarketingEmail` writes `email_send_log{status:'failed'}`,
   which `loadAlreadySent` excludes, so the same recipients are re-attempted every
   30 minutes indefinitely (see C-08).

### Fix

`CROSS-BLOCK: src/lib/cart-recovery.ts:294-300 — mint the coupon only after the stage reservation is held, and do not delete the reservation on a send failure; mark it instead (e.g. status/attempts on abandoned_cart_emails) so hasSentStage still sees it and the retry does not re-mint.`

Separately, in block C's own files: `NoopEmailProvider` should return a result
callers can distinguish — a `skipped: true` / `reason: "disabled"` field —
so "not configured" stops being processed as "provider rejected it". That is a
type change across `EmailSendResult` consumers and is recorded here rather than
made unilaterally, because C-02's fix touches the same result type.

---

## C-07 — `vitest.setup.ts` globally stubs whole subsystems, so tests of them cannot fail

| | |
|---|---|
| **Severity** | P1 (test integrity) |
| **Evidence grade** | A — hit directly while writing C-06 |
| **Status** | `CONFIRMED — CROSS-BLOCK (block E owns test quality)` |

### Evidence

`website/vitest.setup.ts` applies `vi.mock` to eleven modules for **every suite
in the repository**, including:

```ts
vi.mock("@/lib/cart-recovery", () => ({
  runAbandonedCartSweep: async () => ({ t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0 }),
  mintCartRecoveryCoupon: async () => null,
  ...
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
```

C-06's test was written correctly, ran green, and was testing **nothing** — the
sweep it called was the stub, which returns zeros and touches no database. It
only became a real test after adding `vi.unmock("@/lib/cart-recovery")`. Any
existing suite that exercises the cart-recovery sweep, or that believes it has
observed an email send, is in that same position unless it re-mocks locally.

The `sendEmail` stub is the more dangerous of the two: it returns
`{ success: true }` unconditionally, so **no suite can observe a send failure**
without overriding it — and every failure path in this block (C-02, C-05, C-06)
lives behind exactly that result.

### Fix

`CROSS-BLOCK: website/vitest.setup.ts — global module stubs belong in the suites that need them, not in a repo-wide setup file.`
For block E specifically: the flagged "email dedupe" cluster cannot be
mutation-tested while this file is in place — mutating the code under test will
not fail a test that is calling a stub. Auditing which existing suites are
silently hollowed by these eleven mocks is squarely block E's mandate and is
handed over rather than done here.

---

## C-08 — 21 of 36 `sendEmail` call sites throw the result away, so most email failures are invisible

| | |
|---|---|
| **Severity** | P1 |
| **Evidence grade** | A — enumerated across the tree |
| **Status** | `CONFIRMED — mixed ownership, see list` |

### Evidence

```
$ grep -rn "await sendEmail(" src --include=*.ts --include=*.tsx | grep -v test | wc -l
36
$ grep -rn "^\s*await sendEmail(" src ... | wc -l          # result discarded
21
```

`sendEmail` never throws — it returns `{ success: false, error }`. A call whose
result is not read therefore cannot fail, cannot be logged, cannot be queued and
cannot raise an alert. 58% of send sites are in that state, including:

| Call site | What is lost |
|---|---|
| `lib/monitoring.ts:63` | **The critical-alert email itself.** An alert that fails to send is silent, and this is the mechanism that would report it. |
| `lib/payment-webhook.ts:830` | "You earned a commission" — the ambassador is never told, and nothing records that they weren't. |
| `lib/payment-webhook.ts:1746` | Refund confirmation (see C-05). |
| `lib/membership-billing.ts` ×8 | Every membership receipt, reminder and win-back. Money was charged; the receipt may never have arrived. |
| `app/api/checkout/submit-payment/route.ts:109` | Order confirmation on the manual-payment path, plus the owner's "new payment to verify" alert at :124. |
| `lib/partner-portal.ts:556, 577, 1933` | Ambassador application received, owner alert, payout notice. |
| `app/api/admin/orders/[orderId]/route.ts:262, 595` | Shipping update and replacement-shipped notices. |

The two admin *resend* routes are the exception that proves the rule — they read
the result and return HTTP 500 on failure. Everything on the automatic paths does
not.

### Fix

`CROSS-BLOCK: 21 call sites across payment-webhook.ts, membership-billing.ts, monitoring.ts, partner-portal.ts and four route files — read the result; enqueueFailedEmail (transactional) or log the failure (alerts).`

Structural alternative, in block C's own files: make the discard impossible.
Marking `EmailSendResult` as a must-use type is not available in TypeScript, but
a thin `sendTransactionalEmail()` wrapper that queues on failure — the thing
`payment-webhook.ts:1737` already *believes* `sendEmail` does — would convert
every one of these sites into a correct one by construction.

---

## C-09 — The coupon broadcast counts a FAILED send as "already sent"

| | |
|---|---|
| **Severity** | P2 |
| **Evidence grade** | A — provable by inspection, against a fix already applied elsewhere |
| **Status** | `CONFIRMED — CROSS-BLOCK (src/lib/marketing-broadcast.ts)` |

### Evidence

`src/lib/marketing-broadcast.ts:125-138` builds its dedupe set with **no status
filter**:

```ts
.from("email_send_log")
.select("recipient_email")
.eq("campaign_type", "coupon_announcement")
.eq("reference_id", input.coupon.id);
```

`sendMarketingEmail` writes rows with `status: 'failed'` as well as `'sent'`
(`email/marketing.ts:68`) — deliberately, and the reason is written down there:

> a row that doesn't say whether the send succeeded turns a transient provider
> failure into a permanent one: the recipient looks done and is never retried.

`automations.ts:92` applies the corresponding `.neq("status", "failed")` filter,
with its own comment saying the same thing. This path never got it. So a
recipient whose send failed on the first click is reported as `skipped` on every
subsequent click and never receives the announcement — permanently, silently.

Second defect in the same function: the entire audience is walked **serially,
inline, inside one admin HTTP request** (:141-171). `campaign-sender.ts`'s header
describes that exact design as the killed-partway-through problem its batching
replaces — yet `/api/admin/coupons/[couponId]/announce` still does it. A large
list hits the serverless timeout with no resumable state, and because of the
first defect, the recipients it got to are the only ones it will ever get to.

### Fix

`CROSS-BLOCK: src/lib/marketing-broadcast.ts:128 — add .neq("status", "failed"), matching automations.ts:92.`
`CROSS-BLOCK: src/lib/marketing-broadcast.ts:141 — route the broadcast through campaign-sender.ts's claim/batch machinery instead of a serial inline loop.`

---

## C-10 — Automation dedupe is a read-then-write against a table with no unique constraint

| | |
|---|---|
| **Severity** | P2 |
| **Evidence grade** | A — the absent index is confirmed across all four schema files |
| **Status** | `CONFIRMED — block C owns marketing.ts; the index is a schema change (Rule 4)` |

### Evidence

`loadAlreadySent()` (`automations.ts:81`) reads `email_send_log`.
`sendMarketingEmail()` (`marketing.ts:61-72`) inserts the row **after** the
provider call, inside `try { ... } catch { /* Non-fatal. */ }`.

`email_send_log` has no unique constraint — `deploy-run-once.sql:779-781`,
`membership-billing.sql:102-104` and `email-campaigns.sql:222` create only
plain indexes on `reference_id`, `(campaign_type, sent_at)`, `recipient_email`
and `(campaign_id, status)`.

So if the insert fails, or the process dies between provider acceptance and the
insert, the recipient stays eligible and receives the same welcome / win-back on
the next 30-minute sweep — indefinitely. `sendOrderEmailOnce` claims **before**
sending for precisely this reason; the marketing path does not, and has no index
that would let it.

### Fix

Two options, and the cheaper one is worse:

1. **Claim before sending** (mirrors `sendOrderEmailOnce`): insert the
   `email_send_log` row with `status: 'sending'` first, update it to
   `sent`/`failed` after. Requires a unique index on
   `(campaign_type, reference_id, recipient_email)` to be worth anything —
   **schema change, owner approval (Rule 4)**.
2. Retry the insert on failure. Narrows the window; does not close it, and does
   nothing about the process dying.

Option 1 is the one to take, and it composes with C-02: both are the same
claim-before-send discipline, applied to the two halves of the email system that
currently disagree about it.

---

## C-11 — Two admin "resend" paths bypass the send-once machinery entirely

| | |
|---|---|
| **Severity** | P2 |
| **Evidence grade** | A |
| **Status** | `CONFIRMED — CROSS-BLOCK (block I owns src/app/api/admin/**)` |

`POST /api/admin/orders/[orderId] {action:'resend_confirmation'}` (:657) and
`POST /api/admin/payments/[orderId] {action:'resend_email'}` (:147) both render
`orderConfirmationTemplate` and call raw `sendEmail` — no `idempotencyKey`, no
`order_email_log` row, no rate limit. An admin double-click sends two receipts;
`order_email_log` still shows exactly one row from the original webhook send; the
audit row records `payment_resend_email` with no outcome.

`order-email-once.ts` claims its index "makes a duplicate impossible regardless
of who asks". These two callers are the counterexample, alongside the sweep in
C-02.

To their credit, both **do** read the result and return HTTP 500 on failure —
the only two send sites in the app that do (C-08). The fix is to keep that and
route through `sendOrderEmailOnce`, treating `already_sent` as a
"resend anyway, and record it" case rather than a skip: a deliberate operator
resend is legitimate, it just has to leave a trace.

`CROSS-BLOCK: src/app/api/admin/orders/[orderId]/route.ts:657 and src/app/api/admin/payments/[orderId]/route.ts:147 — record admin resends in order_email_log.`

---

## C-12 — The communications panel ignores the proof it already has, and its retry button resends the wrong mail

| | |
|---|---|
| **Severity** | P2 |
| **Evidence grade** | A |
| **Status** | `CONFIRMED — CROSS-BLOCK (order-communications.ts); the retry half is block C's own file` |

Two defects, one screen.

**1. It reports "no failure recorded" where it could report proven delivery.**
`order-communications.ts:162`:

> `// Deliberately not "Sent". Nothing writes a row on success, so this is the strongest true statement available.`

That was true before `order_email_log` existed. It now writes `status: 'sent'`
with a `provider`, a `provider_message_id` and a `completed_at`. The panel simply
never reads that table. The strongest true statement available is much stronger
than the one being made — and this is the screen an operator uses to answer
"did the customer get their receipt?" during a chargeback.

**2. The retry button resends mail the operator did not ask for.**
`retry-queue.ts:120-124` selects `pending_emails where subject ilike '%<orderNumber>%'`
limit 20 — every queued email whose subject mentions that order: confirmation,
shipping, delivery and refund, all re-sent on one click. It also cross-matches any
order number that is a substring of another. `VL-<hex>` makes that unlikely rather
than impossible, and the substring risk is a property of the join, not of the
alphabet.

**3. Related:** `IN_CARRIER_NETWORK` is defined **twice, differently** —
`shippo/service.ts:1596` `{shipped, in_transit, out_for_delivery}` decides
whether a shipping email is *sent*; `order-communications.ts:100` adds
`delivered` and decides whether the panel says one was *due*. A parcel that goes
label → delivered in one scan correctly gets only the delivery email, and the
panel reports the shipping email as due and unproven. Same name, same concept,
two answers.

`CROSS-BLOCK: src/lib/order-communications.ts — read order_email_log for confirmation state, and import IN_CARRIER_NETWORK from shippo/service.ts instead of redefining it.`
Fix in block C's own file: `retryPendingEmailsForOrder` should take the specific
`pending_emails` row id the operator clicked, not a subject substring. This
becomes trivial once C-02's `order_id` column exists.

---

## C-13 — Resuming a stopped campaign mails nobody and reports a full audience

| | |
|---|---|
| **Severity** | P3 |
| **Evidence grade** | A |
| **Status** | `CONFIRMED — CROSS-BLOCK (campaign-sender.ts / send route)` |

The stop route moves `pending`/`claiming` recipients to `cancelled`
(`stop/route.ts:68`). The send route then accepts `paused` as a re-sendable state
(`send/route.ts:87, :116`), and `queueCampaign` upserts with
`ignoreDuplicates: true` against the unique `(campaign_id, email)` index
(`campaign-sender.ts:99`) — so the `cancelled` rows are **not** returned to
`pending`. The campaign flips to `sending`, `recipient_count` is overwritten with
the **full** audience size (:110), nothing is claimable, and the batch marks the
campaign `sent`.

Net effect: the dashboard shows 20 recipients against 3 actual sends, and the 17
people the operator paused for still never hear from the campaign they were
explicitly re-sent.

`CROSS-BLOCK: src/lib/email/campaign-sender.ts:87-113 — on re-queue, return 'cancelled' rows to 'pending' rather than relying on ignoreDuplicates, and set recipient_count from what is actually claimable.`

---

## C-14 — Membership receipts have no claim, unlike the reminders beside them

| | |
|---|---|
| **Severity** | P3 |
| **Evidence grade** | A |
| **Status** | `CONFIRMED — CROSS-BLOCK (membership-billing.ts)` |

Steps 1 and 4 of `runMembershipBillingSweep` claim atomically before sending —
`.is("first_month_reminder_sent_at", null)` then a conditional update to `now`
(:1270-1284), and the same shape for `renewal_reminder_sent_at` (:1434).

Steps 2 and 5 — the **receipts** — do not. They select due rows, call `chargeCard`
with an idempotency key, and on success write the membership row, insert a
`membership_billing_events` row, and send a receipt (:1330-1362, :1485-1525).
Step 3's cancellation win-back has no claim either.

The provider's idempotency key protects the **money**. It does not stop two
overlapping sweeps from both seeing `success`, both inserting a billing event and
both emailing "Receipt: $X charged" for one charge. `Promise.allSettled` across
the sweep's jobs plus a manual invocation is enough to overlap.

Both of those receipt sends also discard their `sendEmail` result (C-08), so the
opposite failure — a receipt for money that *was* taken never arriving — is
equally silent.

`CROSS-BLOCK: src/lib/membership-billing.ts:1330 and :1485 — claim the row before charging, matching steps 1 and 4.`

---

## C-15 — Auth email is a separate, unmonitored channel, and the settings file says otherwise

| | |
|---|---|
| **Severity** | P3 |
| **Evidence grade** | A |
| **Status** | `CONFIRMED — documentation/monitoring gap, no code fix in this block` |

`emailVerificationTemplate` and `passwordResetTemplate` exist in `templates.ts`
with **zero** non-template references. The real magic-link, password-reset and
partner-invite mail is sent by Supabase Auth's own SMTP:

- `components/account-auth-form.tsx:311` — `signInWithOtp`
- `components/account-forgot-password-form.tsx:34` — `resetPasswordForEmail`
- `lib/partner-portal.ts:1373` — `auth.admin.inviteUserByEmail`

Those sends are invisible to `EMAIL_ENABLED`, to the admin settings "ready"
indicator, to `pending_emails`, to `order_email_log` and to every alert in this
app, and they carry a different From and DKIM domain than the transactional
identity. Meanwhile `email/settings.ts:19` lists "password resets, account
verification" among what flows through `sendEmail()`, and :48 and :62 repeat it.

Consequences worth the owner knowing before launch: turning email off in admin
does **not** turn off password resets (good, and undocumented); the admin "email
is ready" indicator says nothing about whether customers can actually recover
their accounts (bad); and nobody is alerted if Supabase's SMTP fails.

`CROSS-BLOCK: src/lib/email/settings.ts:19 — correct the claim.`
Recommended beyond that: surface Supabase Auth SMTP status in the same admin
panel, or state plainly there that account email is a separate channel.

---

# Block C summary

| Id | Severity | Status | Evidence |
|---|---|---|---|
| C-01 | P0 | CONFIRMED, fix CROSS-BLOCK | test, RED ×4 |
| C-02 | P0 | CONFIRMED, fix needs migration approval | test, RED ×3 |
| C-03 | P1 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-04 | P1 | CONFIRMED, fix CROSS-BLOCK | inspection ×3 sites |
| C-05 | P1 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-06 | P1 (money) | CONFIRMED, fix CROSS-BLOCK | test, RED ×2 |
| C-07 | P1 (tests) | CONFIRMED, handed to block E | direct hit |
| C-08 | P1 | CONFIRMED, 21 sites | enumerated |
| C-09 | P2 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-10 | P2 | CONFIRMED, needs index (Rule 4) | inspection + schema |
| C-11 | P2 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-12 | P2 | CONFIRMED, fix part CROSS-BLOCK | inspection |
| C-13 | P3 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-14 | P3 | CONFIRMED, fix CROSS-BLOCK | inspection |
| C-15 | P3 | CONFIRMED, docs/monitoring | inspection |

**Nothing in this block was graded on evidence it does not have.** C-04 is graded
B because the two-email sequence was established by reading three call sites, not
by driving a parcel end to end; everything else marked A is either reproduced by a
committed test or provable from the source as it stands.

**No real email was sent at any point in this block.** Nine test files exist for
these findings' subject matter; the three added here mock the provider and capture
every message. Nothing was written to production.

## What block C did NOT verify

- **The live provider.** Whether `admin_control.email.enabled` is currently true,
  and which provider is configured, was not read. If it is SendGrid or SMTP, the
  Resend `Idempotency-Key` path is inert and `order_email_log` is the sole
  duplicate guard — which C-02 shows is one-way. Needs a production read.
- **Whether `order-email-log.sql` is applied in production.** `sendOrderEmailOnce`
  treats a missing table as "send anyway, unlogged", and `isMissingTable` matches
  any error containing "does not exist" or "schema cache" — so an absent table
  removes the only send-once guarantee with no alert at all. Needs a production
  read.
- **Live `pending_emails` rows at `status='failed'`**, and `order_email_log` rows
  at `failed` whose orders were nonetheless delivered by the sweep. Each of the
  first is a customer who got nothing; each of the second is an order exposed to a
  duplicate receipt on any replay.
- **Whether `MARKETING_POSTAL_ADDRESS` is set.** If blank, `marketingBlockedReason()`
  blocks campaigns and automations — but cart recovery, coupon broadcast,
  back-in-stock and membership welcome/win-back all call `sendMarketingEmail`
  **without** that gate and would still send non-CAN-SPAM-compliant mail.
- **`notification_queue` consumption.** Nothing outside `updatePartnerStatus`'s
  inline mark-as-sent appears to consume rows of kind
  `partner_application_approved`/`rejected`; unsent rows may simply accumulate
  into `getAdminOperationsSummary`'s pending count.
- **Browser verification.** Block C is server-side; no customer-facing email UI
  was driven. The admin email settings screen and the communications panel
  (C-12) would benefit from it and are left to blocks G+H.
