# FINAL VERIFICATION LOG — independent pre-merge review

Session: final-verify-merge (branch `claude/vanta-labs-final-verify-merge-84fzl0`,
based on the integration head `eb80a55`).

Every number below came from a command run in this session. Where it contradicts
a number written elsewhere in this repository, the contradiction is stated.

---

## PART 1 — MERGE SAFETY

### 1.1 Ancestry

```
$ git rev-parse origin/claude/vanta-labs-code-review-j6qb7t
eb80a5505378e4ea564eead9d6a07023409be5b0
$ git rev-parse origin/main
9aea901ede54914a8f5be8a35066f0ffb0a76efa
$ git rev-parse origin/claude/vanta-audit-final-block-m-faj8j6
0ca55216e773d430c13a9b4535a2dd673ea01cd4
$ git merge-base --is-ancestor 0ca5521 origin/claude/vanta-labs-code-review-j6qb7t
YES ancestor
$ git merge-base --is-ancestor 9aea901 origin/claude/vanta-labs-code-review-j6qb7t
YES
```

Block M's head **is** an ancestor of the integration head. The prompt's
precondition holds. `faj8j6` is fully contained and is correctly treated as
superseded.

### 1.2 Does it merge cleanly / has main moved?

`main` is at `9aea901` and is an **ancestor** of the integration head. main has
not moved since the audit began. The merge is therefore a strict fast-forward
with **zero possible conflict**; no throwaway-worktree conflict test is needed
to establish that, and none can produce a conflict.

### 1.3 Actual size of the work

```
$ git diff --shortstat 9aea901..eb80a55
 239 files changed, 40721 insertions(+), 1391 deletions(-)
$ git rev-list --count 9aea901..eb80a55
140
```

Production code only (`website/src/**`, excluding `*.test.ts`):
**7,281 insertions / 743 deletions**.

### 1.4 Commits stranded on block branches — NONE

```
for b in <all ten block branches>; do git rev-list --count eb80a55..origin/$b; done
```

| branch | commits not reachable from integration head |
|---|---|
| claude/vanta-audit-final-block-m-faj8j6 | 0 |
| claude/audit-superpowers-playwright-extension-c2oyhm | 0 |
| claude/vanta-labs-audit-resume-754dol | 0 |
| claude/browser-testing-blocks-gh-egmzo3 | 0 |
| claude/block-ab-audit-6fogsm | 0 |
| claude/block-ab-audit-8xz6fb | 0 |
| claude/block-ab-audit-o62bop | 0 |
| claude/block-ab-audit-zuuyuz | 0 |
| claude/audit-blocks-f-e-8jxi9v | 0 |
| claude/audit-parallel-assignments-block-k-r8fpix | 0 |

**No fix was lost in the merge.** This is the first direct test of that failure
mode and it comes back clean.

### 1.5 Working tree / pushed state

Integration branch working tree clean at session start; `origin/...j6qb7t` and
the local head are the same commit `eb80a55`. Nothing unpushed.

### 1.6 CORRECTION TO A REPORTED NUMBER

Block N's own commit message and `INTEGRATION-LOG.md` state Block N added
**2,902 insertions across 30 files**, of which **566** are production code.
Measured:

```
$ git diff --shortstat 0ca5521..eb80a55
 30 files changed, 3091 insertions(+), 126 deletions(-)
$ git diff --numstat 0ca5521..eb80a55 -- 'website/src/**' ':!*.test.ts' ':!*.sql'
insertions 602 deletions 81
```

The real figures are **3,091 insertions** and **602 lines of production code**,
not 2,902 and 566. Both of Block N's corrected figures were still undercounts.
The direction of the error is consistent: more unread code than reported.

**PART 1 VERDICT: CLEAN.** Ancestry holds, nothing stranded, fast-forward merge.

---

## PART 6.1 — DOES MERGING TO main DEPLOY?  **YES. THIS BLOCKS THE MERGE.**

This was checked before anything else that could lead to a merge, and it is the
single decisive result of this session.

**GitHub Actions:** none. `.github/workflows/` does not exist.

**Vercel git integration:** the project `vanta-labs`
(`prj_uUdavqjTwSFZCIJ8BxIrXjQp5ocI`, team `team_mYQ1nzN5ge279mjxaLG26lYe`) is
linked to `brendenhuntzinger1/vanta-labs` via the GitHub integration, and serves
`vantalabsresearch.com` / `www.vantalabsresearch.com`.

Direct evidence that a push to `main` deploys to **production**, from the
deployment history:

```
dpl_aQHYozA58q3v5MQ8hZRhG7a85Hck
  githubCommitRef: main
  githubCommitSha: 9aea901ede54914a8f5be8a35066f0ffb0a76efa
  target:          "production"
  state:           READY
```

```
dpl_gocvr3v4NyApggyC5m4jFxwkdzF1
  githubCommitRef: main
  githubCommitSha: b19db0c...
  target:          "production"
```

Every non-`main` branch push in the same window produced `target: null`
(preview). Every `main` push produced `target: "production"`.

**Merging this branch into `main` and pushing would immediately build and
promote 7,281 lines of unreleased production code to the live storefront.** The
owner authorised a merge, not a deploy. Per the standing instruction, this is a
STOP.

### 6.1b — and the deploy would be actively destructive

Not merely "a deploy we did not ask for". Verified by direct read against
production Postgres (`mlpimwgkwuqpsvsrlpqv`):

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='referral_orders'::regclass;
```
```
referral_orders_payment_status_check
  CHECK (payment_status = ANY (ARRAY['paid','refunded','partially_refunded']))
referral_orders_order_id_key   UNIQUE (order_id)
```

The new accrual code writes `payment_status: "pending"`
(`src/lib/payment-webhook.ts:759`). **`'pending'` is not in the production
CHECK.** Every commission accrual would be refused with `23514` on the live
store, for every ambassador sale, from the moment the code is promoted — which
is exactly the failure mode the whole commission-lifecycle work exists to fix.

The migration that widens it — `src/lib/sql/referral-orders-commission-lifecycle.sql`
— is **staged and NOT applied**. `DEPLOYMENT-ORDER.md`'s migration-before-code
ordering is therefore not advisory: it is load-bearing, and it is confirmed
independently here rather than taken on trust.

**PART 6 VERDICT: MERGE BLOCKED.** Not by a defect in the code — by the fact
that the merge is a deploy, and the deploy is unsafe today.

---

## PART 4a — THE GATE (in progress at time of writing)

- `npm ci` — exit 0
- `npm run lint` — exit 0, **0 errors, 42 warnings**
- `npx tsc --noEmit` — exit 0
- `npm test` — see below
- `npm run build` — see below

Already observed during the test run, and material: three test modules print a
`SKIPPED:` banner and self-disable because `VANTA_TEST_DATABASE_URL` is unset —
`affiliate-concurrency`, `partner-status-integrity`, `partner-invite-atomicity`.
Their own banners state they cover double payout, the exactly-once payout claim,
the auto-approve read/write race and admin-invite atomicity, and that these are
**NOT covered by any in-memory test**. These are money-path proofs that did not
run in this gate.

### PART 4a — THE GATE, FINAL NUMBERS (clean `npm ci` checkout of `eb80a55`)

| step | result |
|---|---|
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 — **0 errors, 42 warnings** |
| `npx tsc --noEmit` | exit 0, clean |
| `npm test` | exit 0 — **Test Files 255 passed / 9 skipped (264)**, **Tests 4101 passed / 78 skipped (4179)**, 0 failed |
| `npm run build` | exit 0 — `✓ Compiled successfully`, `✓ Generating static pages (105/105)` |

**CONTRADICTION OF A RECORDED NUMBER.** Block N recorded
`264 files / 4179 tests / 0 failed / 0 skipped`. The file and test **totals** are
right. **`0 skipped` is wrong: 9 files and 78 tests are skipped.** The totals
were read off the summary line and the skip count was assumed.

#### The 78 skips, named — and then RUN

Six of the nine print a `SKIPPED:` banner. **Three print nothing at all** — the
exact silent-skip trap this audit has already been bitten by. The silent three
are 36 of the 78 tests, all of them financial reporting.

| file | tests | banner? |
|---|---|---|
| `src/lib/admin-financial-surfaces.test.ts` | 21 | **silent** |
| `src/lib/financial-reporting-consistency.test.ts` | 8 | **silent** |
| `src/lib/financial-reporting-row-caps.test.ts` | 7 | **silent** |
| `src/lib/affiliate-concurrency.test.ts` | 9 | yes |
| `src/lib/inventory-return-path.test.ts` | 10 | yes |
| `src/lib/partner-identity-convergence.test.ts` | 7 | yes |
| `src/lib/partner-invite-atomicity.test.ts` | 7 | yes |
| `src/lib/partner-status-integrity.test.ts` | 6 | yes |
| `src/lib/sql/bulk-savings-rollup-executed.test.ts` | 3 | yes |
| **total** | **78** | |

All nine gate on `VANTA_TEST_DATABASE_URL`. **This session stood one up** —
PostgreSQL 16.13, `initdb -A trust`, port 55440, a separate database per suite —
and ran all nine:

```
admin-financial-surfaces          21 passed  EXIT=0
affiliate-concurrency              9 passed  EXIT=0
financial-reporting-consistency    8 passed  EXIT=0
financial-reporting-row-caps       7 passed  EXIT=0
inventory-return-path             10 passed  EXIT=0
partner-identity-convergence       7 passed  EXIT=0
partner-invite-atomicity           7 passed  EXIT=0
partner-status-integrity           6 passed  EXIT=0
bulk-savings-rollup-executed       3 passed  EXIT=0
                                  78 passed
```

**With a database supplied, the true gate is 4,179 / 4,179 passing, 0 skipped,
0 failed.** These are the double-payout, exactly-once-payout-claim,
auto-approve-race, partner-invite-atomicity, inventory-return-path and
row-cap proofs — the money-path suites — and they are DATABASE-PROVEN here for
the first time. No previous session in this audit had run them.

**Action owed regardless of the merge:** the three silent skips must print a
banner like the other six. A financial-reporting suite that disappears without
a word is how 36 assertions go missing while the run reports success.

---

## PART 2 — THE UNREAD PRODUCTION CODE, READ

602 lines of production code across 14 files (measured; Block N said 566).
Read highest-risk first, as an independent reviewer, arguing with each claim.

### `commission-accrual-repair.ts` (+148/−0) — the hardest read. **HOLDS.**

Three adversarial questions were put to it.

**Can it double-pay?** No, and for a stronger reason than the file gives.
`referral_orders` carries `referral_orders_order_id_key UNIQUE (order_id)`
(verified in production). The sweep selects on the ABSENCE of a row, so a repeat
run is a no-op; and in the one genuine race — the live webhook accruing while a
sweep runs on the same order — the second insert is refused by the unique key,
counted as `failed`, and alerted. It cannot produce two commission rows. The
file's own justification (idempotent by absence) is true but not sufficient on
its own; the unique key is what actually closes it, and the file does not say so.

**Can it accrue for a refunded order?** No. `referral_orders` rows are **never
deleted** anywhere in the repository — grepped across all writers
(`ambassador-commission.ts`, `admin-ambassadors.ts`, `payment-webhook.ts`,
`partner-portal.ts`, `commission-accrual-repair.ts`); refunds move
`payment_status`, they do not remove the row. So there is no resurrection path:
a reversed commission stays present and the sweep skips it.

**Does it reproduce the live rule, or a second one?** This is the question that
would have made it a new N-04, and it is the one the file does not prove. It
does reproduce it, exactly. All three lanes compute the same two inputs:

```
payment-webhook.ts:1458  (card)    commissionableSubtotal = subtotal − discount_amount
payment-webhook.ts:1049  (manual)  commissionableSubtotal = subtotal − discount_amount
payment-webhook.ts:631   (repair)  commissionableSubtotal = subtotal − discount_amount
```

and all three route through the single `ensureCommissionRecord`. **Verified, not
assumed.**

### `payment-webhook.ts` (+127/−20) — the latch placement. **CORRECT.**

`paid_side_effects_at` is stamped **last**, after `finalizeInventoryForOrder`,
guarded `.is("paid_side_effects_at", null)`. The reasoning in the docblock is
sound and I agree with it: the latch must mean "the stock moved", not "the stock
is about to move". A crash between the decrement and the latch leaves the latch
NULL and a later cancel under-restocks — a recoverable shortage. The opposite
placement would let a cancel restock units that were never removed, inventing
stock. The failure direction chosen is the conservative one.

Wrapping the manual lane's accrual and analytics in `try/catch` is right and
minimal: everything below them (coupon redemption, points, confirmation email,
membership activation, `finalizeInventoryForOrder`) was previously destroyed by
one throw behind a single-use claim, and the commission is no longer lost by
catching because the repair sweep re-derives it.

### `shippo/service.ts` (+61/−0) — restock at the chokepoint. **HOLDS, and I tested the claim rather than the code.**

The load-bearing claim is "this is the ONLY writer". I enumerated every write of
`fulfillment_status` in `app/` and `lib/`. Two functions write a computed
`transition.next`:

- `setOrderFulfillmentStatus` (service.ts:1999) — the chokepoint. Three callers:
  `route.ts:162` (dropdown), `route.ts:623` (Cancel button),
  `admin-orders.ts:241` (bulk). All three cancel paths go through it.
- the Shippo tracking webhook (service.ts:1873) — **cannot** produce `cancelled`.
  `TRACKING_STATUS_MAP` (order-pipeline.ts:492) maps only to
  `label_purchased | in_transit | out_for_delivery | delivered | returned`, and
  `mapShippoTrackingStatus` returns null for anything undocumented.

Every other `fulfillment_status` write is a literal (`pending`,
`awaiting_fulfillment`, `fulfilled`, `label_purchased`). **There is no fourth
cancel path.** The chokepoint claim is true by exhaustion, not by comment.

`label_purchased → cancelled` raises `cancellation_after_label_purchase` and
does **not** restock. Correct: postage is spent and the parcel may be with the
carrier, so restocking would invent units.

### `rate-limit.ts` (+74/−2) — per-instance denied-bucket memo. **HOLDS.**

Bounded at `MAX_DENIED_BUCKETS = 10_000` with expiry-first eviction then
insertion-order eviction, so it cannot grow without limit in a warm lambda. The
short-circuit returns the same `retryAfterSeconds` the database would, and the
memo entry is deleted as soon as the window passes.

### `inventory-fulfillment.ts` — the tri-state claim. **CORRECT, AND IT MATTERS TODAY.**

`claimInventoryRestock` now returns `claimed | already_claimed | unavailable`.
Verified against production:

```sql
select column_name from information_schema.columns
where table_name='orders' and column_name='inventory_restocked_at';
-- 0 rows
```

**`orders.inventory_restocked_at` does not exist in production.** So today every
call returns `unavailable`, the cancel path raises a **critical**
`cancellation_inventory_unresolved` alert, and returns `{action:"unavailable"}`
rather than the old lie of `already_returned`. That is the honest behaviour, and
it makes `sql/add-inventory-restock-claim.sql` a **deploy blocker**, not an
optional step: without it, every cancellation on the live store returns no stock
and pages a human.

### The four cross-module claims I was asked to check myself

| claim | verdict |
|---|---|
| `shippo/config.ts:49` — "every money-spending path checks this" | **CONFIRMED FALSE.** `isShippoLive()` appears exactly once in the repository — its own definition. **Zero callers.** |
| `admin-tax-report.ts:77` ↔ `admin-profit.ts:88` | **CONFIRMED NOT IDENTICAL** — see below. |
| `payment-mock.ts:6` | **Comment is misleading as filed.** The module is pure and imports no DB, so "re-reads identity from the DB" is not literally true of this file; but the substantive half is: a mock envelope is built from an order the mock already looked up, a live envelope is not, and the `payment_id` join and `isRecognisedMoneyEvent` guard have no mock coverage. The grading consequence stands: **a passing mock payment does not certify the live callback.** |
| `cart-recovery.ts:268` | Not independently re-verified this session. Left OUTSTANDING as filed. |

#### The tax pair — a confirmed, still-open divergence

```
admin-tax-report.refundedTaxFor          admin-profit.refundedTaxPortion
  tax==0 || refund==0                      taxCollected<=0 || refund<=0
    -> status=='refunded' ? tax : 0          -> 0                        <-- DIFFERS
  paid<=0  -> tax                          amountPaid<=0 -> taxCollected
  else min(tax, tax*min(1,refund/paid))    else  (identical formula)
```

For an order marked `refunded` with **no** `refund_amount` and non-zero tax, the
filing report counts the **whole** tax as refunded and the profit report counts
**zero**. The two reports disagree about the same refund — exactly what both
comments claim is impossible, each naming the other as the source of truth.

**Reachability, measured against production:**

```sql
select payment_status, count(*) ... from orders group by payment_status;
paid 6 | canceled 5 | pending_payment 4
```

**Zero refunded rows exist.** The divergence is real and still open, but
**latent**: it cannot be producing a wrong filing today. Severity P2, and both
comments must be corrected whichever way it is resolved.

### A counting error in the register written to correct counting errors

`INTEGRATION-LOG.md` → "BLOCK N — CROSS-MODULE CLAIM REGISTER (the full 28, not
a summary)" states 28 claims and heads a section "OUTSTANDING — P2 (18)".
Counted programmatically:

```
  6  Fixed in Block N (6)
  2  OUTSTANDING — P1 (2)
 16  OUTSTANDING — P2 (18)     <-- header says 18, table has 16
  2  OUTSTANDING — P3 (2)
 26  TOTAL ROWS                <-- heading says 28
```

**Two claims are named in the totals and absent from the register.** The
outstanding count is therefore **20 listed, 22 asserted**. This is the fourth
counting error in this audit's own reporting, and it is in the document written
specifically to stop them. It does not change any verdict; it does mean the
register is not yet the complete inventory it says it is.

---

## PART 3 — DUPLICATE AND CONFLICTING CODE

Findings, by the rule the prompt asked to be traced. Not consolidated — reported.

| rule | implementations | agree? |
|---|---|---|
| revenue | `ledger.isRevenueOrderStatus`, used by `admin-analytics.ts:56`, `admin-email.ts:123`, `admin-profit.ts:328`, `admin-membership.ts:689`, `best-sellers.ts:43` | **YES — converged by N-04.** Previously zero call sites with five surfaces using three rules. Verified: the hand-written second implementation in `admin-profit.ts` is gone and replaced by the import. |
| a cancelled order / restock | single chokepoint `setOrderFulfillmentStatus`; 3 callers | **YES — by construction.** Exhaustively verified above; no fourth writer. |
| refunded tax | `admin-tax-report.refundedTaxFor`, `admin-profit.refundedTaxPortion` | **NO — confirmed divergent, latent.** |
| commissionable subtotal | 3 lanes in `payment-webhook.ts` (1458, 1049, 631) | **YES — identical formula, one shared writer.** |
| paid order | `paid_side_effects_at` now written by both lanes | **YES — converged by N-02.** |

**Dead code, confirmed:** `isShippoLive()` — defined, exported, **zero callers**,
sitting under a comment claiming every money-spending path calls it. Same shape
as the `isRevenueOrderStatus` defect (N-04) that was just fixed. It is the next
one of these to close.

**Duplicate SQL constraints, checked against PRODUCTION, not the .sql files:**
`pc_ro_ps` — the duplicate that silently defeated a by-name constraint drop on
the harness — **does not exist in production** (`select count(*) from
pg_constraint where conname='pc_ro_ps'` → 0). Production carries only
`referral_orders_payment_status_check`. The drop-by-rule loop in
`referral-orders-commission-lifecycle.sql` is still the right way to write it.

**Migrations in source with no live counterpart** — at least three, verified:
`referral-orders-commission-lifecycle.sql` (the CHECK is still narrow),
`add-inventory-restock-claim.sql` (`orders.inventory_restocked_at` absent),
`pending-emails-order-link` (`pending_emails.order_id` absent).

**No commit from any block branch was lost** (Part 1.4) — so no block silently
reverted another at the commit level.

---

## PART 4b — TEST-THE-TESTS: NINE REAL MUTATIONS, NINE CAUGHT

Not a review of the tests — the production code was actually broken, the suite
run, and the code restored. Working tree verified clean afterwards.

| # | mutation (production code) | suite | result |
|---|---|---|---|
| M1 | `claimInventoryRestock` returns `already_claimed` instead of `unavailable` — collapses the tri-state back into the original defect | `inventory-restock-claim.test.ts` | **2 failed** ✔ |
| M2 | delete the `returnInventoryForCancelledOrder` call at the chokepoint | `cancel-restocks-every-path.test.ts` | **3 failed** ✔ |
| M3 | `LABEL_BOUGHT_STATUSES` guard forced false — a post-label cancel restocks instead of alerting | `cancel-restocks-every-path.test.ts` | **2 failed** ✔ |
| M4 | repair sweep drops its "already accrued" filter — would re-accrue every order | `commission-accrual-recovery.test.ts` | **1 failed** ✔ |
| M5 | repair sweep counts a failed accrual as repaired | `commission-accrual-recovery.test.ts` | **1 failed** ✔ |
| M6 | manual lane never stamps `paid_side_effects_at` | `manual-payment-cancellation-inventory.test.ts` | **4 failed** ✔ |
| M7 | `isRevenueOrderStatus` narrowed to `paid` only | `revenue-definition-agreement.test.ts` | **1 failed** ✔ |
| M8 | rate limiter never short-circuits a denied bucket | `rate-limit-concurrency.test.ts` | **2 failed** ✔ |
| M9 | rate-limiter memo never evicts — unbounded growth | `rate-limit-concurrency.test.ts` | **1 failed** ✔ |

**9 applied, 9 caught, 0 survivors.** These are the money and inventory
assertions specifically. No placebo was found among Block N's new tests: every
one of them fails for the right reason when the defect it names is reintroduced.
This is the strongest evidence in this report, and it contradicts the prior
expectation that more placebos were waiting in this diff.

Two intended mutations did not apply because the pattern did not exist in the
file; they are reported as NOT RUN rather than as passes.

---

## PART 4c — THE PURCHASE: **NOT INDEPENDENTLY RE-VERIFIED THIS SESSION**

Stated plainly rather than upgraded. This session did **not** drive a purchase
through a browser against a production build. `INTEGRATION-LOG.md` §6.1 records
Block M doing exactly that against the harness, screen against database at each
step, on code contained in this branch, and §6.2 records a defect only the
browser found. That evidence is real and it is on this tree — but it is Block
M's, not an independent repetition, and I am not relabelling it as mine.

What this session did prove that bears on the same paths:
`npm run build` is green (105/105 pages) and the nine database-gated suites,
including `inventory-return-path`, run and pass against a real Postgres.

---

## PART 4d — THE THREE RECENT REPAIRS

**(i) A failed commission accrual is recoverable.** Verified by reading
(`commission-accrual-repair.ts` holds under all three adversarial questions
above) and by mutation (M4, M5 both caught). Nothing below the accrual is lost
any more: the throw is caught on the manual lane and `finalizeInventoryForOrder`
now runs regardless. **VERIFIED (code + test).**

**(ii) All three cancel paths restock.** Verified by exhausting the writer set,
not by trusting the chokepoint comment — there is no fourth path, and the
tracking webhook provably cannot reach `cancelled`. M2 and M3 confirm the tests
catch removal of the restock and inversion of the post-label guard.
**VERIFIED (code + test).** Not browser-proven on all three admin surfaces.

**(iii) `claimInventoryRestock` distinguishes the three outcomes.** Verified in
code and by mutation M1, and the production reality — the column is absent —
is confirmed by direct query. **VERIFIED, and it raises a deploy blocker.**

---

## PART 4e — GRADES, HONESTLY

| area | grade |
|---|---|
| Merge safety, ancestry, no lost commits | **PROVEN** (git, this session) |
| main auto-deploys on push | **PROVEN** (Vercel deployment record, this session) |
| Production schema drift (3 unapplied migrations) | **DATABASE-PROVEN** (this session) |
| Full gate: lint / tsc / tests / build | **PROVEN** (this session) |
| The 78 previously-skipped money-path suites | **DATABASE-PROVEN** (this session, real Postgres 16) |
| Block N's new tests are not placebos | **PROVEN** by 9/9 mutation controls (this session) |
| Commission repair correctness | **PROVEN** by read + mutation; **NOT** exercised against a live processor |
| Cancel restock on all three paths | **PROVEN** in code and test; **NOT** browser-proven |
| Order creation through the UI | **BROWSER-PROVEN by Block M** — not repeated here |
| Anything after the processor | **HARNESS-PROVEN by Block M** — not repeated here |
| Real card entry, live VeyraGate callback, signed-in flows, RLS, realtime | **NOT VERIFIED** |

The harness has no GoTrue and no RLS, and per `payment-mock.ts` a passing mock
payment does not certify the live callback. No grade has been laundered upward.

---

# PART 7 — THE VERDICT

## 1. WAS IT MERGED? **NO.**

Parts 1–4 came back clean. The merge was blocked by Part 6 step 1, which is a
precondition on the merge itself, not a defect in the code:

**Merging to `main` deploys to production in this repository.** Proven from the
Vercel deployment record: commit `9aea901` on `main` produced deployment
`dpl_aQHYozA58q3v5MQ8hZRhG7a85Hck` with `target: "production"`, aliased to
`vantalabsresearch.com`. Every non-`main` push in the same window produced
`target: null`. There is no GitHub Actions workflow; the Vercel git integration
is the deploy trigger and it is armed.

The owner authorised a merge. He did not authorise a deploy. The instruction for
this exact case was to stop and say so.

**And the deploy would be actively destructive, not merely premature.**
Production's `referral_orders_payment_status_check` still admits only
`('paid','refunded','partially_refunded')`. The new code writes `'pending'`
(`payment-webhook.ts:759`). Promoting this code before applying
`referral-orders-commission-lifecycle.sql` means every ambassador commission on
the live store is refused with `23514` from the first sale — while the store
takes orders normally and reports success. Separately,
`orders.inventory_restocked_at` does not exist, so every cancellation would
return no stock and page a human.

**This is not a reason to abandon the merge — it is a reason to sequence it.**
See §2.

## 2. THE SEQUENCE FROM HERE TO A LIVE STORE

Verified against production rather than taken from `DEPLOYMENT-ORDER.md`.

**Launch blockers, in order. Each must be applied BEFORE any code is promoted.**

| # | step | why it is a blocker | verified |
|---|---|---|---|
| 0 | Owner rotates the email-provider credentials (I-01) and purges the historical audit rows | The secrets were exposed in plaintext; the code fix closes the read, not the exposure | — |
| 1 | Apply `sql/referral-orders-commission-lifecycle.sql` | Without it **every commission accrual fails** the moment the new code is live, with no reconstruction path for the lost rows | ✅ CHECK still narrow in production |
| 2 | Apply `sql/add-inventory-restock-claim.sql` | Without it **every cancellation returns no stock** and raises a critical alert | ✅ `inventory_restocked_at` absent |
| 3 | Apply the inventory-RPC migration (STEP 2) | `adjust_inventory_on_sale` absent | ✅ absent; `finalize_inventory_for_order` present |
| 4 | Apply the `pending_emails.order_id` migration (C-02) | Duplicate receipts otherwise | ✅ column absent |
| 5b | Drop the duplicate rate-limit index | **Moved from optional to run-before-deploy.** Confirmed as stated in `DEPLOYMENT-ORDER.md`. | — |
| 6 | Publish the COAs (F-006) | The storefront advertises COA documentation and **zero COAs exist**. Legal exposure, independent of code. | — |
| 7 | **Only now** merge to `main` — which deploys | | |
| 8 | Immediately after: confirm one referred order accrues exactly one commission, and one cancellation returns stock | The two things the migrations exist for | |

**Optional, not blockers:** the 20 outstanding cross-module comment claims; the
three silent test skips (repo hygiene, not customer-facing); `isShippoLive()`;
the tax-pair divergence (latent — production has zero refunded orders).

**A safer alternative worth putting to the owner:** merge to `main` with the
Vercel production branch temporarily detached or the deployment paused, so the
audit record lands in `main` without promoting code. That separates the two
decisions the owner actually has — "is this work accepted" and "is this work
live" — which are currently welded together by the git integration.

## 3. OBJECTIVE ABORT CONDITIONS — stop mid-deploy if any of these is true

1. Any migration reports success but the object is not actually present or the
   rule not actually changed. **Re-query after every migration.** This exact
   failure has already happened once in this audit: a constraint dropped by name
   left a duplicate under another name in force, and the migration reported
   success while every commission still failed.
2. `select pg_get_constraintdef(oid) from pg_constraint where conrelid='referral_orders'::regclass` does not admit `'pending'` after Step 1.
3. `orders.inventory_restocked_at` is still absent after Step 2.
4. More than one constraint on `referral_orders.payment_status` exists at any point.
5. The first referred order after deploy produces zero or more than one `referral_orders` row.
6. The first cancellation after deploy does not increase the stock count, or raises `cancellation_inventory_unresolved`.
7. Sentry shows any `23514` or `23502` on `referral_orders` or `orders`.
8. The production build fails, or serves a page the preview did not.

Any one of these: roll back the Vercel deployment (`isRollbackCandidate: true`
on the prior production deployment) and stop. The migrations are additive and do
not need reversing to make the old code safe.

## 4. WHAT IS OWED BY THE OWNER, NOT AN ENGINEER

1. **Rotate the email-provider credentials** and purge the historical
   `admin_audit_logs` rows containing them (I-01). The code fix closed the
   viewer; it did not un-expose the secret.
2. **Publish the COAs** (F-006 / K-21). The footer and the age gate both promise
   COA documentation and there are none.
3. **Approve the staged migrations**, including **Step 5b**.
4. **Decide whether merging may deploy** — or authorise detaching the Vercel
   production branch first. This is the immediate decision.
5. **Business rules still undecided:** whether Bac Water is stock-tracked (D-07);
   GIF support on product images (I-06); the cart-recovery discount rate that is
   hardcoded as "5% off" (K-02); coupon redemption when the coupon loses the
   discount competition (K-22); visitor-data retention for four tables that are
   written and never read (K-20); whether the free Buy-3-Get-1 unit is reserved
   (J-06); **and — found in this session — whether a `returned` parcel puts its
   units back into sellable stock. Nothing in this audit has recorded a decision
   on that, and `returned` currently does not restock.**
6. **Compliance attestations (K-18).** Four are collected at checkout and none is
   durably recorded on the card lane. This is legal exposure and I recommend
   treating it as a launch blocker rather than an optional item.
7. **CI (F-015).** There is no continuous integration of any kind — `.github/`
   does not exist. Every gate in this audit was run by hand. That is an owner
   decision about how this codebase is maintained after launch.

## 5. VERDICT

# 🔴 NOT MERGED — these blockers first

**The code is in better shape than the merge decision is.** Nothing found in
Parts 1–4 blocks it: ancestry is clean, no commit was stranded on any of the ten
block branches, the gate is green, all 78 previously-skipped money-path tests now
run and pass against a real Postgres, and nine real mutations against the most
safety-critical new code were all caught. Block N's 602 unread production lines
hold up under an adversarial read.

**What blocks it is that in this repository, merging *is* deploying** — and three
migrations the code depends on are not applied. Merging today would put a store
live that silently destroys every ambassador commission and returns no stock on
any cancellation.

Two things unblock it, and both are the owner's to give:

1. Apply the staged migrations (Steps 1–4 and 5b above), **or**
2. Authorise merging with the Vercel production branch detached, so the audit
   record lands in `main` without promoting code.

Say which, and the merge takes minutes.

---

# MIGRATION RUN LOG — 2026-08-26

## STEP 0 — **NO RESTORE POINT EXISTS. PROCEEDING ANYWAY, BY OWNER DECISION.**

Recorded verbatim, unsoftened, because it changes the risk of every step below.

**Confirmed from the Supabase dashboard by the owner:** the project
`mlpimwgkwuqpsvsrlpqv` is on the **FREE plan**. The free tier provides **no daily
backups and no point-in-time recovery**. **There is no restore point, and none
can be created without upgrading the plan.**

**The owner's decision, in his words:** *"I have decided to proceed without one."*

What that means concretely, stated plainly rather than reassuringly:

- `DEPLOYMENT-ORDER.md` Step 0 says a snapshot "is the rollback for everything
  below" and "**ABORT if** no restore point exists". **We are knowingly running
  against that instruction.**
- Every step below has a written, dry-run rollback. Those cover the failure modes
  that were *predicted*. **Nothing covers an unpredicted one.** If a rollback
  itself misbehaves, there is no floor to fall back to — recovery would be by
  hand, from whatever state was captured beforehand.
- This is why the run was tightened at the owner's instruction: the current state
  each step would change is captured into this log **and committed before the
  step runs**, so a manual reconstruction is possible without a database
  snapshot.

Partial mitigation, measured — not offered as a substitute:

```sql
select name, setting from pg_settings where name in ('archive_mode','archive_command','wal_level');
archive_mode     on
archive_command  /usr/bin/admin-mgr wal-push %p >> /var/log/wal-g/wal-push.log 2>&1
wal_level        logical
```

WAL archiving is running. **This does not constitute a restore point** — WAL
segments are only usable when replayed onto a base backup, and the free plan
retains none. It is recorded so nobody later mistakes it for a backup.

**ACCEPTED RISK — OWNER DECISION — NO RESTORE POINT.**

---

## Pre-Step-1 answer: the live `coupons.storefront_headline` error

Production is logging, on currently-deployed code:

```
42703  column coupons.storefront_headline does not exist
400    GET /rest/v1/coupons
```

**Does the branch fix it? NO — it inherits it, byte for byte.**
`storefront-offers.ts` is **identical** at `9aea901` and at `eb80a55` (lines 56,
81, 139 unchanged). Deploying changes nothing about this.

**Is it in the fix register under a finding id? NO.** `storefront_headline`
appears in **no** findings document, no block report, and no register entry.
Grepped across all of `website/docs/`. **It is a new finding.**

**What it breaks for a customer: nothing.** This is a deliberate
graceful-degradation ladder, not a failure. `publicCoupons()` tries three
column-sets widest-first and drops to the next on error:

```
tier 1  … is_private, member_scope, storefront_headline, storefront_priority   <-- 42703 here
tier 2  … is_private, member_scope                                             <-- SUCCEEDS
tier 3  … (base columns only)
```

Only if **all three** fail does it throw. Verified against production: every
tier-2 column exists (`is_private`, `member_scope` both present);
`storefront_headline` and `storefront_priority` are the only two absent. **Tier 2
succeeds, so the offers bar renders correctly** using the generated headline and
the default priority of 10.

**What it actually costs:**

1. **Observability damage — the real cost.** One 400 + one `42703` per offers-bar
   render, permanently, in Sentry and the Postgres logs. A by-design probe is
   indistinguishable from a genuine missing-column error at a glance, so this
   trains everyone to ignore exactly the error class that *is* load-bearing
   elsewhere in this audit (`inventory_restocked_at` fails with the same 42703).
2. **An inert feature.** Operators cannot override an offer headline or its
   ordering. The fallback is the *generated* headline, which the code notes
   "cannot drift" from the discount — so the default is arguably the safer one.

**Does it block the deploy? NO.** It is pre-existing, unchanged by this branch,
customer-invisible, and closed by an additive migration
(`sql/coupon-storefront-fields.sql`) that can run at any time. Filed as
**PLB-04** in `POST-LAUNCH-BACKLOG.md`. It should be closed soon — not because it
breaks anything, but because a permanently-red error is how a real one hides.

---

## STEP 1 — pre-state capture (committed BEFORE the step runs)

Exact current state, for manual reconstruction if the rollback misbehaves:

```
constraint name : referral_orders_payment_status_check
definition      : CHECK ((payment_status = ANY (ARRAY['paid'::text, 'refunded'::text, 'partially_refunded'::text])))
column default  : 'paid'::text
rows in table   : 0
constraint count matching payment_status : 1
```

**Manual reconstruction, if ever needed:**
```sql
alter table public.referral_orders drop constraint if exists referral_orders_payment_status_check;
alter table public.referral_orders add constraint referral_orders_payment_status_check
  check (payment_status = any (array['paid','refunded','partially_refunded']));
alter table public.referral_orders alter column payment_status set default 'paid';
```

Zero rows, so no data can be lost by any outcome of this step.

### STEP 1 — APPLIED ✅

Verify output:

```
constraint_count_MUST_BE_1 : 1
definition : CHECK ((payment_status = ANY (ARRAY['pending'::text, 'approved_for_payout'::text,
             'paid'::text, 'reversed'::text, 'voided'::text, 'refunded'::text,
             'partially_refunded'::text])))
col_default : 'pending'::text
```

**The hard-stop check passed: ONE constraint, not two.** The drop-by-rule loop
found and removed exactly the one legacy constraint; no duplicate under another
name existed in production (as predicted — `pc_ro_ps` was harness-only). The
commission lifecycle can now be written. **M-01 / G-01 is CLOSED in production.**

---

## STEP 2 — pre-state capture (committed BEFORE the step runs)

```
orders.inventory_restocked_at exists      : 0  (absent)
adjust_inventory_on_sale exists           : 0  (absent)
orders_inventory_restock_pending_idx      : 0  (absent)
orders rows                               : 15
products rows / total inventory_quantity  : 46 / 115
product_doses rows / total inventory_qty  : 71 / 1139
```

**The two stock totals are the number that matters.** This step creates the
function that moves them, and the currently-deployed code begins calling it
successfully the moment it exists. `products` total **115** and `product_doses`
total **1139** are the pre-migration baseline; nothing in this step writes to
either, so both must be unchanged immediately afterwards.

**Manual reconstruction, if ever needed:**
```sql
drop function if exists public.adjust_inventory_on_sale(text, text, integer);
drop index if exists public.orders_inventory_restock_pending_idx;
alter table public.orders drop column if exists inventory_restocked_at;
```
Safe while no order carries a non-null `inventory_restocked_at` — true now
(the column does not exist), and it must be re-checked before any later rollback.

### STEP 2 — APPLIED ✅

Verify output:

```
col_exists_expect_1              : 1
fn_exists_expect_1               : 1
anon_execute_expect_false        : false
authd_execute_expect_false       : false
service_role_expect_true         : true
idx_expect_1                     : 1
products_total_qty_expect_115    : 115     <-- unchanged
doses_total_qty_expect_1139      : 1139    <-- unchanged
already_restocked_expect_0       : 0
```

Every value as predicted. **The two stock totals are byte-identical to the
pre-state**, confirming the step moved no inventory. The new function is
service_role only — `anon` and `authenticated` are both denied EXECUTE, so this
did not reintroduce the I-07 exposure class while restoring the function.

**Live behaviour change, as forecast:** the currently-deployed code's
`adjust_inventory_on_sale` fallback and its `inventory_restocked_at` restock
claim both work from this moment. Webhook refunds now return stock. Admin
cancellations still do not — that half ships with the code.

**G-04 / I-12 residual and the restock-claim half of G-02 / K-17 are CLOSED in
production.**

---

## STEP 3 — pre-state capture (committed BEFORE the step runs)

```
pending_emails rows : 0
columns             : id:uuid, to_email:text, subject:text, html:text, text_body:text,
                      reply_to:text, attempts:integer, status:text, last_error:text,
                      next_attempt_at:timestamptz, created_at:timestamptz, updated_at:timestamptz
pending_emails_order_idx exists : 0
```

Zero rows — nothing can be lost. `order_id` and `email_kind` are both absent, as
expected.

**Manual reconstruction, if ever needed:**
```sql
drop index if exists public.pending_emails_order_idx;
alter table public.pending_emails drop column if exists order_id, drop column if exists email_kind;
```

### STEP 3 — APPLIED ✅

Verify output:

```
email_kind                                  : text
order_id                                    : text
order_email_log.order_id (must match type)  : text     <-- types agree, the write-back join works
pending_emails_order_idx                    : 1
```

`order_id` is `text`, matching `order_email_log.order_id`. Had it landed as
`uuid` the send-once write-back would have failed on every join and C-02 would
have looked fixed while still sending second receipts. **C-02's schema half is
CLOSED in production.**

---

## STEP 4 — pre-state capture (committed BEFORE the step runs)

`referral-code-management.sql` builds `uq_ambassadors_referral_code`, a UNIQUE
index over `ambassadors(referral_code) where referral_code is not null`. **Full
contents of what that index builds over, captured verbatim** — this is the one
step in the run that touches populated live data:

| id | referral_code | status |
|---|---|---|
| 28bbd306-d97a-46e7-9d80-9cddbe10092f | BRUTUS | approved |
| f6a44e24-e610-405d-abd3-93b89c7f918c | ELIJAH-AB78AE | info_requested |
| 45b0e626-f5da-4d62-b84e-77e263e89b13 | SMOKE | approved |
| d289c2c3-f386-49e8-84ca-decd640b6fdf | ZAIN | approved |
| fd2331d1-b8c9-47b1-a65d-54509c8367f8 | ELOA | approved |
| af0b3dd9-509a-46b6-9cf7-dfacfc9644f9 | FLAVIAROSSETTI | approved |
| 8bd67041-34b8-46bd-9aac-02a669342d55 | MIZZY | approved |
| 2da54572-6e5d-4e97-86e2-9cb70eab4636 | 1ANGEL | pending |

**8 rows, 8 distinct codes, 0 NULLs, 0 duplicates.** The unique index will build.
This was pre-checked before the run was proposed; it is captured again here in
full because a UNIQUE index is the only thing in this run that can fail on
*data* rather than on schema.

Also absent and to be created: `referral_code_aliases`, `referral_code_changes`,
and `referral_code_locked` / `referral_code_changed_at` on both `ambassadors`
and `partners`.

**Manual reconstruction, if ever needed:**
```sql
drop table if exists public.referral_code_aliases;
drop table if exists public.referral_code_changes;
drop index if exists public.uq_ambassadors_referral_code;
alter table public.ambassadors drop column if exists referral_code_locked,
                               drop column if exists referral_code_changed_at;
alter table public.partners    drop column if exists referral_code_locked,
                               drop column if exists referral_code_changed_at;
```
Safe only while `referral_code_aliases` holds no rows — an alias is a live
redirect for links already printed. It is empty now (the table does not exist).
