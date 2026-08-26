# Block E-A — Test quality (session `claude/block-ab-audit-zuuyuz`)

Session branch: `claude/block-ab-audit-zuuyuz` (this session ran block C, then
block E). Scope per the assignment table: `*.test.ts` and the test harness.

> **Note for block M:** this branch carries **9 deliberately failing tests** from
> block C (findings C-01, C-02, C-06). They are evidence, not breakage — see the
> banner at the top of `BLOCK-C.md`. Every number in this file is quoted against
> that baseline: **9 failed | 3577 passed | 7 skipped (3593)**.

---

## E-A-01 — `vitest.setup.ts` stubbed eleven modules for every suite; nine were load-bearing for nothing

| | |
|---|---|
| **Severity** | P1 (test integrity — undermines every other block's evidence) |
| **Evidence grade** | A — each stub removed in isolation, full suite re-run, result recorded |
| **Status** | **FIXED on this branch** |
| **Raised as** | block C finding C-07, handed to E, closed here |

### How it surfaced

Writing C-06's regression test. The test called `runAbandonedCartSweep()`,
asserted on the result, and **passed** — while calling this, from
`vitest.setup.ts`:

```ts
vi.mock("@/lib/cart-recovery", () => ({
  runAbandonedCartSweep: async () => ({ t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0 }),
  mintCartRecoveryCoupon: async () => null,
  ...
}));
```

A stub that touches no database, mints nothing, and cannot fail. The test only
became real after adding `vi.unmock("@/lib/cart-recovery")`. Any suite in the repo
exercising one of these eleven modules was in the same position unless it happened
to re-mock locally.

The `@/lib/email/send` stub was the most dangerous of the eleven:

```ts
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
```

Unconditional success. **No suite in this repository could observe a failed
email send** — which is the exact result that findings C-02, C-05 and C-06 all
live behind. The email subsystem was structurally untestable, and every "email
dedupe" test in the flagged clusters was scored against a stub.

### The measurement

Rather than argue about it: each of the eleven `vi.mock()` blocks was removed
**in isolation**, the full suite re-run, and the result recorded.

| Stub removed | Tests failed | Suites that actually depend on it |
|---|---|---|
| `@/lib/email/send` | 9 (baseline) | **0** |
| `@/lib/coupons` | 9 | **0** |
| `@/lib/membership` | 9 | **0** |
| `@/lib/cart-recovery` | 9 | **0** |
| `@/lib/admin-control` | 9 | **0** |
| `@/lib/tax-provider` | 9 | **0** |
| `@/lib/membership-billing` | 9 | **0** |
| `@/lib/fulfillment/service` | 9 | **0** |
| `@/lib/ambassador-settings` | 9 | **0** |
| `@/lib/catalog` | 10 | 1 test |
| `@/lib/supabase-server` | 20 | 11 tests |

**Nine of the eleven were load-bearing for exactly zero tests.** Every suite that
genuinely needed one already re-mocked it locally. They cost nothing to delete and
were silently hollowing out any suite that did not re-mock — including any written
tonight by the five other audit sessions.

The two that mattered are needed by exactly two suites:
`payment-service.test.ts` and `payment-webhook-identity.test.ts`. The
`@/lib/supabase-server` stub is a bespoke in-memory fake with `paymentEvents`,
`orders`, `referralOrders`, `ambassadors` and `products` maps — written for those
two suites and applied to all 206.

### The fix (applied)

1. **Deleted** the nine dead stubs.
2. **Moved** the catalog and supabase-server fakes to
   `src/test-support/payment-suite-fakes.ts`, bodies unchanged, exported as
   `catalogModule()` and `supabaseServerModule()`.
3. The two suites that need them now **ask for them explicitly**:
   ```ts
   vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
   vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());
   ```
4. `vitest.setup.ts` now holds the policy and the reason, and no stubs.

### Verification

```
before:  Test Files  3 failed | 202 passed | 1 skipped (206)
         Tests       9 failed | 3577 passed | 7 skipped (3593)
after:   Test Files  3 failed | 202 passed | 1 skipped (206)
         Tests       9 failed | 3577 passed | 7 skipped (3593)
npx tsc --noEmit  →  clean
npm run lint      →  0 errors, 38 warnings (all pre-existing, none in changed files)
```

Identical, test for test. The refactor is behaviour-preserving.

**The proof that the trap is actually gone:** C-06's regression test had
`vi.unmock("@/lib/cart-recovery")` as a workaround. That line has been **removed**,
and the test still detects the defect — still failing on
`expected [...] to have a length of 1 but got 3`. It now exercises the real sweep
because nothing is stubbing it, rather than because it fought the harness.

### Why this matters beyond block E

This is a **precondition for the other blocks' evidence, not a tidy-up.** Five
other sessions are writing tests tonight against a harness that silently replaced
eleven modules. Any test any of them wrote that touched email, catalog, coupons,
memberships, tax, fulfillment or cart recovery may have been scoring a stub.

`CROSS-BLOCK: every block that added tests tonight should re-run them on the merged branch after this lands. A test that passed before and fails after was measuring the stub.`

Specifically for block E's own remit: the flagged **"email dedupe"** cluster could
not be mutation-tested at all before this change — mutating `sendEmail`'s callers
cannot fail a test whose `sendEmail` always returns `{ success: true }`.

---

## E-A-02 — Mutation testing the six flagged clusters: 14 mutants, 2 real survivors, both closed

| | |
|---|---|
| **Severity** | P1 (one survivor guarded a money control with zero coverage) |
| **Evidence grade** | A — every verdict is a recorded full-suite run |
| **Status** | **BOTH SURVIVORS CLOSED on this branch** |

### Method

Fourteen mutations, each a single semantic change to **source** (never to a test),
chosen so that each one corresponds to a defect this business could actually
suffer. Each was applied alone, the **entire** suite run, and the file reverted.
Running the whole suite rather than a hand-picked subset removes the "the auditor
missed a suite" failure mode.

**A correction to the method, mid-run, that changed two verdicts.** The first
pass scored KILLED / SURVIVED by comparing the *count* of failing tests against
the baseline of 9. That is unsound when the baseline is non-zero: a mutation can
create one failure and silence another, netting zero. It did exactly that. **M05**
was scored SURVIVED on the count; comparing the *set* of failing test names showed
it both broke `order-email-once.test.ts` and silenced one of C-02's assertions
(the mutant forces every log row to `sent`, which is what that assertion is
complaining about). M05 is **killed**. All survivor verdicts below were re-run
with set comparison; KILLED verdicts from a count *increase* remain sound, since
a higher count guarantees at least one new failure.

### Results

| Cluster | Mutants | Killed | Survived |
|---|---|---|---|
| fulfillment-state | 3 | 3 | 0 |
| payment-idempotency | 2 | 2 | 0 |
| inventory-decrement | 2 | 2 | 0 |
| commission-calculation | 2 | 2 | 0 |
| email-dedupe | 3 | 2 | **1** |
| payout-authority | 2 | 1 equivalent | **1** |

**Four of the six flagged clusters killed every mutant put to them**, including
mutations as consequential as *a paid order increases stock instead of decreasing
it*, *pay every ambassador ten times their rate*, *remove the webhook's atomic
side-effects claim*, and *allow cancelling an order after it has shipped*. Those
clusters were flagged for review and come out of it well; that is a real result
and is reported as one.

### Survivor 1 — the commission hold period had zero test coverage (M07)

```
src/lib/partner-portal.ts, autoApproveEligibleCommissions
-  return Number.isFinite(createdAt) && now.getTime() - createdAt >= holdPeriodMs;
+  return Number.isFinite(createdAt);
→ 3,593 tests, ZERO new failures
```

**This is the most serious finding in block E.** The hold period is the only
control standing between a commission accruing and money being sent to an
ambassador for an order that can still be refunded or charged back. Deleting it
entirely was invisible to the whole suite.

Category: **no test covers it.** The only file naming
`autoApproveEligibleCommissions` is `src/app/api/cron/sweep/route.test.ts`, which
does `vi.mock("@/lib/partner-portal", () => ({ autoApproveEligibleCommissions: () => commissions() }))`
— it asserts the sweep *calls* something, never that the something is correct. The
real function was executed by no test in the repository.

**Closed by** `website/src/lib/payout-authority-guards.test.ts` (7 tests, new).
It drives the real function and pins the boundary from both sides: a
one-day-old commission and one a single day short of the hold are **not**
approved; one past it is; and with both sitting in the table only the aged one
moves. It also locks the three gates beside it that were equally untested — order
not paid, ambassador no longer approved, fraud-flagged.

Verified: re-applying M07 now produces exactly **3 new failures**, all in this
file. Before it, zero.

### Survivor 2 — the automation dedupe filter was untested (M13)

```
src/lib/email/automations.ts, loadAlreadySent
-  .neq("status", "failed")
→ 3,593 tests, ZERO new failures
```

The line's own comment states the stake: *"A failed attempt must stay eligible, or
one provider hiccup silently drops that recipient from the sequence permanently."*
Deleting it means a customer whose welcome or win-back email failed once is
treated as served for ever — the customers the system has already failed once.

Category: **no test covers it.** `loadAlreadySent` has no direct test, and
`runAutomationSweep` appears only in the sweep route test, which mocks
`@/lib/email/automations` wholesale.

This is the mirror image of block C's **C-09**: the same guard is *absent* in
`marketing-broadcast.ts`, where it is a live defect. Present-and-untested in one
path, missing in the other.

**Closed by** `website/src/lib/email/automation-dedupe-guard.test.ts` (4 tests,
new). Three recipients — one whose prior send is logged `failed`, one `sent`, one
never emailed — and the assertion that exactly the first and third are served.
Verified: re-applying M13 produces **2 new failures**, both in this file.

### Not a survivor: an equivalent mutant, reported as such (M08)

```
src/lib/partner-portal.ts, markCommissionsPaid
-  .in("payment_status", ["approved_for_payout"]);
+  .in("payment_status", ["approved_for_payout", "pending"]);
→ ZERO new failures
```

Initially filed as a second payout-authority gap. It is **not one**, and the
distinction is worth the paragraph: the widened `select` only builds a *candidate*
id list, and the authoritative step is the atomic claim below it —

```ts
.update({ payment_status: "paid", ... }).in("id", ids)
.eq("payment_status", "approved_for_payout").select(...)
```

— which re-filters, and pays exactly the rows it claimed. The mutation cannot
change observable behaviour, so no test can kill it. **An equivalent mutant is a
sign of defence in depth, not of missing coverage, and inflating the survivor
count with it would have misrepresented this cluster.**

Two things were confirmed rather than assumed:

1. Removing the **claim guard** instead (`.eq("payment_status", "approved_for_payout")`)
   **is** killed — by the existing `"two simultaneous payouts pay once between
   them"` test. The control that matters is covered.
2. With **both** mutations applied, a held commission does get paid
   (`expected 85.5 to be 25.5`). The new test added to
   `affiliate-end-to-end.test.ts` is what catches that pair — a commission still
   inside its hold period sitting beside an approved one, which that suite's
   fixture never contained. A boundary the fixture never crosses cannot be tested
   by crossing it.

### The hold-period tests exercise the real implementation, and the mutation control is retained

Asked directly, and verified two independent ways, because the failure mode being
guarded against is exactly what hid M07 in the first place — a suite asserting
against a stub.

**1. In-suite assertion.** `payout-authority-guards.test.ts` opens with a
`describe("this suite is wired to the real implementation")` block that fails if
`@/lib/partner-portal` is ever mocked:

```ts
expect(vi.isMockFunction(autoApproveEligibleCommissions)).toBe(false);
```

A stub could satisfy that by accident, so a second test asserts on a side effect
only the real function can produce — the exact approval write the fake database
observed: `expect(db.approvals).toEqual([{ ids: ["ripe"], status: "approved_for_payout" }])`.
Only supabase, admin-control and ambassador-settings are faked; never the module
under test.

**2. The M07 mutation control, re-run after every later change.** Deleting the
hold comparison from the real source still produces exactly three failures, all
in this file:

```
== M07 new failures vs baseline:
   + ... > approves only the aged commission when fresh ones sit beside it
   + ... > does not approve a commission one day short of the hold period
   + ... > does not approve a commission that is one day old
== M07 failures that DISAPPEARED:   (none)
```

M13's control was re-run alongside it and still produces its two failures. Both
controls are documented here so they can be re-run by block M rather than taken
on trust; the mutation catalogue is
`/tmp/.../mutations.json` in-session, and each entry is reproduced verbatim in
this document's tables.

### Verification

```
before E-02:  Tests  9 failed | 3577 passed | 7 skipped (3593)
after  E-02:  Tests  9 failed | 3589 passed | 7 skipped (3605)
after  C-06 fix + guards:  Tests  7 failed | 3609 passed | 7 skipped (3623)
```

The drop from 9 failures to 7 is C-06's two regression tests going green when
that defect was fixed — not a test being weakened.

**+12 tests, no new failures.** The 9 are still block C's deliberate ones.
`npx tsc --noEmit` clean; `npm run lint` 0 errors, 38 pre-existing warnings, none
in the new files.

### What block E did NOT do

- **Only 14 mutants.** A serious mutation campaign runs hundreds, generated
  rather than hand-picked. These were chosen for consequence, not coverage, so
  "4 of 6 clusters killed everything" means *these* mutants died — not that those
  clusters are exhaustively tested.
- **The six clusters only.** The rest of the suite was not mutation-tested.
- **The parallel fleet planned for this did not run.** A six-agent workflow, one
  isolated worktree per cluster, was launched and every agent died on a session
  rate limit. The work above was done serially in this session instead, which is
  why the mutant count is 14 and not 60.
- `CROSS-BLOCK: the pre-existing suites were not re-run against E-01's harness change by their owning blocks. Any block that added tests tonight should re-run them on the merged branch — a test that passed before E-01 and fails after was measuring a stub.`
