# BLOCK E — Test quality

Phase 15. Mutation-test the six flagged clusters; a test that cannot fail gets
replaced, not patched. Scope: `*.test.ts` (plus `vitest.setup.ts` and
`src/lib/e2e/fake-db.ts`, which are test infrastructure).

Branch: `claude/audit-blocks-f-e-8jxi9v`, from
`origin/claude/audit-superpowers-playwright-extension-c2oyhm`.
Merged into the ledger by the consolidation session (block M). No verdict here.

---

## Method

Every claim below is a **measured mutation**, not a reading. Each mutation was
applied to production source with `scripts/mutate.sh`, the suite was run, and
the file was restored from a byte copy. "Survived" means the whole suite stayed
green with the defect in place.

The runner restores from a **copy, not `git checkout`** — a fix under test is
usually uncommitted, and reverting to HEAD deletes it and then reports that the
tests "caught" a mutation of code that no longer existed. That happened once
before the runner was corrected; every result below was produced afterwards.

Baseline at the start of this block: **3,620 tests, all passing.**
After this block: **3,675 tests, all passing** (`tsc` clean, `eslint` 0 errors).

---

## Summary — 14 mutations, 6 survived

| Cluster | Mutation | Survived? | Verdict |
|---|---|---|---|
| Commission calculation | commission base includes shipping | ❌ caught (16) | **covered** — map's prediction disproved |
| Commission tier | seed `matched` from `tiers[0]`, greps intact | ✅ **survived** | E-02 |
| Commission tier | neutralise the locked-rate return, grep intact | ✅ **survived** | E-02 |
| Payout authority | delete `canManageRefunds` on the payout route | ✅ **survived** | E-03 |
| Payout authority | hardcode `confirmedTransferred: true` | ✅ **survived** | E-03 |
| Payout authority | hardcode `overrideMinimumThreshold: true` | ✅ **survived** | E-03 |
| Payout authority | delete the minimum-threshold guard | ✅ **survived** | E-03 |
| Payout authority | delete the "still approved?" guard | ✅ **survived** | E-03 |
| Inventory decrement | strict-`false` oversell check → `null` | ❌ caught (2) | covered |
| Inventory decrement | degraded finalize reports phantom success | ✅ **survived** | E-04 |
| Inventory decrement | decrement one unit regardless of quantity | ❌ caught (3) | covered |
| Payment idempotency | remove the manual-lane fallback condition | ❌ caught (13) | covered |
| Email dedupe | delete the 23505 once-claim | ❌ caught (2) | covered, but see E-06 |
| Fulfillment state | email on every carrier scan, not the transition | ❌ caught (3) | covered |

Plus, found while fixing Block F: **E-01**, a grep that went red on a safe
refactor and would have stayed green on the defect it names.

---

## E-01 — A placebo that failed on a refactor and would pass on the bug

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 (false confidence) · **Status:** REPLACED

`src/lib/replacement-economics.test.ts` → "the dashboard counts sales and
reshipments separately" asserted that `admin-profit.ts` **contained the literal
string** `String(row.orderType ?? "").toLowerCase() === "replacement"`.

Its own comment names the defect it is guarding: "`orderCount += 1` fired for
replacements too". It cannot detect that — rewriting the branch while leaving
the literal anywhere in the file (a comment, an unused local) passes. It **did**
fail, on a behaviour-preserving refactor that moved the rule into `ledger.ts`.

Replaced with real assertions against `isSaleOrder`, including the case/null
handling and the arithmetic the defect got wrong, plus a pointer to the
end-to-end count pinned against real Postgres in
`admin-financial-surfaces.test.ts`.

---

## E-02 — The commission rate an ambassador is paid had no behavioural test

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (19 new tests)

`getEffectiveCommissionPercent` decides the percentage on **every referred
order**. Coverage before this block:

- `vi.mock()`'d in all six suites that reach it.
- `e2e/commission-eligibility.test.ts` runs it for real but never seeds a
  `commission_tier_rules` row, so the tier loop is dead there.
- The only defence was four `readFileSync` greps in
  `elijah-referral-scenario.test.ts`, two of them whitespace-exact multi-line
  string matches.

### The greps cannot detect the bug they name

Both of these reproduce the historical defect exactly while leaving **every
literal those tests assert on intact**. The full 3,620-test suite stayed green
for both:

```ts
let matched: (typeof tiers)[number] | null = null;
matched = tiers.at(0) ?? null;                        // inserted below it

if (ambassador) ambassador.commission_percent_locked = false;   // inserted above
if (ambassador?.commission_percent_locked) { ... }              // untouched
```

The first pays an ambassador who qualified for nothing the lowest tier — the
exact incident the code comment describes, where "the rate the owner typed in
the admin was therefore never used". The second lets a tier silently override a
rate an admin explicitly locked.

### Fix

`src/lib/commission-tier-resolution.test.ts` — 19 tests against the real
function, real tier rows and real referral history on a stateful fake database.
Covers: a tier must be earned; a zero-threshold tier still applies to everyone
(the deliberate owner choice the fix must not have broken); climbing to the
highest earned rung; a locked rate pinned both above and below the tier it
would otherwise get; and every reason an order does **not** advance a tier
(reversed, voided, manual review, $0 earned, marked ineligible, fraud-flagged,
last month) — including a self-dealing ambassador with 20 fraud-flagged orders
who must not reach the top rung.

Every describe carries its own negative control, so "the fifth sale did not
count" cannot be confused with "five never counts".

The four greps are **replaced**, not patched, with a note recording why.

### Negative controls

| Mutation | Result |
|---|---|
| seed `matched` from `tiers[0]` (greps intact) | **10 of 19 failed** |
| neutralise the locked-rate return (grep intact) | 2 failed |
| invert the qualification comparison | 14 failed |
| stop excluding fraud-flagged / $0 / reversed orders | 3 failed |

---

## E-03 — Nobody could send an ambassador money wrongly and be noticed

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (13 new tests)

Two files carry names that claim payout coverage —
`ambassador-payout.test.ts` (3 tests) and `final-invariants.test.ts`
"INVARIANT 10". Between them they test one thing: the `isValidPayoutMethod`
string enum. **Nothing imported `PATCH` from
`src/app/api/admin/partners/[partnerId]/route.ts`**, and nothing exercised
either guard inside `markCommissionsPaid`.

Five mutations, five survivals, all 3,620 tests green each time:

| # | Mutation | What it means in the real world |
|---|---|---|
| 1 | delete `if (!canManageRefunds(session.role))` | a packer can pay any ambassador any balance |
| 2 | hardcode `confirmedTransferred: true` | commissions flip to "paid" for money nobody sent |
| 3 | hardcode `overrideMinimumThreshold: true` | the owner's payout floor stops existing |
| 4 | delete the minimum-threshold guard | same, one layer deeper |
| 5 | delete `if (partnerStatus !== "approved")` | releases the held balance of an ambassador **disabled for fraud** |

(2) is the worst of them: the money leaves Vanta by hand over Zelle/PayPal, so
there is no processor record to reconcile against. A payout recorded but never
sent is indistinguishable from one that was.

### Fix

`src/lib/payout-authority.test.ts` — drives the **real route handler** and the
**real `markCommissionsPaid`** against a stateful fake that models
conditional-UPDATE row counts, so the atomic claim behaves as it does in
Postgres. Asserts on the money, not just the status code: no `partner_payouts`
row, no commission flipped to `paid`, no email.

Covers anonymous (401), staff (403), manager (200), owner (200); both
money-moving flags read from the request rather than assumed, including
`"true"`, `1`, `"yes"` and `{}` all failing the `=== true` check; and four
non-approved statuses each holding the balance. Each guard has a paired
negative control proving it is a condition and not a blanket refusal, and each
refusal must **name its reason** — a bare 400 is indistinguishable from a
malformed request.

### Negative controls — all five now caught

| # | Result |
|---|---|
| 1 delete the role check | 1 failed |
| 2 hardcode `confirmedTransferred` | 2 failed |
| 3 hardcode `overrideMinimumThreshold` | 1 failed |
| 4 delete the threshold guard | 1 failed |
| 5 delete the approved-status guard | 4 failed |

---

## E-04 — A broken inventory RPC could report success and take nothing off the shelf

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED (12 new tests)

`src/lib/inventory-reservation.test.ts` imports `InventoryReservationModel`
from `inventory-reservation-model.ts` — a hand-written in-memory mirror whose
own header admits it is "a pure, in-memory mirror of the inventory-reservations
SQL RPCs". The real module, the one that calls `supabaseAdmin.rpc`, is never
imported by it.

Mutation: change `finalizeInventoryForOrder`'s catch to
`return { finalized: 1, degraded: false }`. **All 3,663 tests stayed green.**

The caller's guard is `if (fin.degraded || fin.finalized === 0)`. That return
value is a phantom success: the legacy decrement is suppressed, a paid order
deducts nothing, and the next shopper buys stock that is already gone.

Fail-open here is deliberate and correct — an RPC outage must not block a real
customer at checkout. What matters is that it fails open **while telling the
caller**, because the caller has a fallback and only runs it when told to.

`src/lib/inventory-reservation-degraded.test.ts` covers every unhappy path of
`finalizeInventoryForOrder`, `reserveInventoryForOrder` (including the strict
`false` oversell comparison and the `null` "RPC not installed" case),
`expireStaleReservations` and `releaseInventoryForOrder`. Negative controls: the
phantom-success mutation, the widened oversell comparison and a dropped
`degraded` flag are all caught.

**Still NOT VERIFIED:** the SQL RPCs themselves (`reserve_inventory`,
`finalize_inventory_for_order`) have never been executed by any test. Block F's
`pg-supabase-adapter` makes that reachable now; it belongs to whoever owns
Phase 16 (concurrency).

---

## E-05 — The function that takes membership money had zero coverage

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (15 new tests)

`vitest.setup.ts` globally stubs `@/lib/membership-billing` to two no-op
exports, so `startMembershipSignup` had **no behavioural coverage anywhere**.
Everything that reached it saw the stub.

Restoring the defect the source itself names — a **failed** first charge writing
a membership row — left all 3,660 tests green. That defect made an account
display a tier name, an access-until date and a next-billing date it had never
paid for.

`src/lib/membership-signup-behaviour.test.ts` unmocks the module deliberately
(the stub stays for everyone else) and drives the real function against the fake
database, replacing only the outside edges: card processor, Veyra client, email.

Pinned invariants, each one quoted from or named by the source:

- A failed charge leaves **no** membership row and sends no welcome.
- `veyra_membership_id` is "THE load-bearing write" — present on the processor
  lane, null on the legacy lane. Drop it and the member is billed twice a month,
  once by Veyra's cron and once by ours.
- Annual is a one-year pass: the processor is told to stop, the local row says
  `cancel_at_period_end`, and no next amount is promised.
- If the processor refuses to stop, the signup still succeeds (the customer paid
  for their year) **and** raises a critical alert.
- A missing email refuses **before** the charge — an orphaned recurring
  subscription is worse than a failed signup.
- The trap case: an "active" member with no processor subscription, or one
  winding down, must be allowed to buy again. Silently returning success left
  them with no charge, no card presented and nothing in their history.
- A tier change repricies the next charge to the new tier rather than charging
  again.

Six mutations, all caught. Two were re-run against the whole suite: **nothing
else catches either**.

---

## E-06 — Findings that DISPROVE parts of the map

The standard says a hypothesis that cannot be reproduced is `UNCONFIRMED`, not
silently fixed. Four of the map's Phase-15 predictions did not hold.

**Commission calculation is behaviourally covered.** The map predicted that
mutating the commission base at `payment-webhook.ts:673` would leave everything
green except three named suites, and that if those also stayed green "commission
math has no behavioral coverage at all". Measured: **16 tests failed**, in
`affiliate-end-to-end.test.ts` and `ambassador-commission-lifecycle.test.ts` —
both genuinely behavioural. `order-of-operations.test.ts` and
`elijah-referral-scenario.test.ts` *are* mirror placebos as described, but they
are redundant mirrors, not the only defence. **Not replaced** — deleting
redundant-but-harmless tests is not this block's remit.

**Payment idempotency is covered.** Removing the manual-lane
`if (fin.degraded || fin.finalized === 0)` fallback condition failed **13
tests**. The map predicted the suite would stay green.

**Fulfillment state regression is covered for the rule tested.** Removing
`!wasInNetwork`, so every carrier scan emails, failed **3 tests** in
`shippo/service.test.ts` and `shippo/tracking-lifecycle.test.ts`. The map's
broader point — that the WRITE SITES' use of `canTransition` is asserted only by
greps — was not separately tested here and remains open.

**Modelling `order_email_log`'s index bought no detection.** The map predicted
that adding the missing unique keys to `fake-db.ts` would let the e2e suites
catch an email-dedupe defect. Measured A/B, with and without: **identical, 13
failures either way.** The outer `paid_side_effects_at` claim short-circuits
before the email claim is reached, so the e2e suites' "exactly once" assertions
are protected by the outer guard and cannot exercise the inner one. The index is
still modelled (it is schema fidelity, verified against the live database, zero
regressions) but it is not coverage.

`partner_payouts` has only a primary key in production — there was no unique
constraint for the map to have expected.

---

## E-07 — Coupon fuzzing that was fuzzing nothing

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED

`ambassador-financial-invariants.test.ts`, `fuzz-invariants.test.ts` and
`order-lifecycle-simulation.test.ts` all import `calculateCouponDiscount` and
**none** called `vi.unmock("@/lib/coupons")`, so they received
`vitest.setup.ts`'s stub returning `0`. Every coupon assertion across roughly
40,000 generated cases reduced to `0 >= 0`.

Verified: making the real function return `subtotal * 10` (unbounded) left all
three green while failing 12 tests elsewhere.

All three now unmock it, keep their full test counts (5 / 11 / 5), pass against
the real math, and catch that mutation. The two tautologies the map identified in
`ambassador-financial-invariants` (calling a function twice with identical
arguments and asserting `a === b`) are **NOT FIXED** — flagged for consolidation.

---

## E-08 — The eleven global stubs are now documented

`vitest.setup.ts` applies eleven `vi.mock()`s to all 200+ suites. That is
deliberate, but a global stub is invisible coverage loss: a suite that imports a
stubbed module without `vi.unmock()` is testing the stub, and nothing says so.

The file now carries a header recording, for each stub, **where the real module
is actually exercised** — measured, not assumed. Two entries are findings in
their own right (E-05, E-07). One is dead: `@/lib/fulfillment/service` mocks a
module that **does not exist in `src`** and that nothing imports; the stub is
inert and can be deleted by whoever owns that cleanup.

---

## NOT VERIFIED / handed on

- **The SQL RPCs themselves.** `reserve_inventory`,
  `finalize_inventory_for_order`, `adjust_inventory_on_sale` have never been
  executed by a test. Reachable now via Block F's `pg-supabase-adapter`;
  belongs to Phase 16.
- **Whether the fulfillment WRITE SITES call `canTransition`.** Still asserted
  only by greps in `handoff-invariants.test.ts` (52 tests, 83 `toContain` over
  `readFileSync`) and `fulfillment-labels.test.ts`. The state machine itself is
  well covered; its callers are not. Not attempted here.
- **The remaining 46 source-text files.** Only the ones intersecting the six
  flagged clusters were examined. A general Tier-C sweep is a block of its own.
- **The two tautologies in `ambassador-financial-invariants.test.ts`**
  ("tax and shipping can NEVER contribute to commission" and the refund-state
  determinism test) — identified, not replaced.

## CROSS-BLOCK

- `src/lib/inventory-reservation-model.ts` is a hand-written mirror that the
  suite named after the real module tests instead of it. It should either be
  deleted or explicitly reframed as a design document; that is a decision for
  whoever owns inventory (Block D), not a test-quality edit.
- `vitest.setup.ts`'s `@/lib/fulfillment/service` stub targets a non-existent
  module — dead code, Block K.
