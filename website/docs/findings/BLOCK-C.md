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
