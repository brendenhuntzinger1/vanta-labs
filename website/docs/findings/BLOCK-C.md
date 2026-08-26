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
