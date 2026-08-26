# Block E — Test quality

Session branch: `claude/block-ab-audit-zuuyuz` (this session ran block C, then
block E). Scope per the assignment table: `*.test.ts` and the test harness.

> **Note for block M:** this branch carries **9 deliberately failing tests** from
> block C (findings C-01, C-02, C-06). They are evidence, not breakage — see the
> banner at the top of `BLOCK-C.md`. Every number in this file is quoted against
> that baseline: **9 failed | 3577 passed | 7 skipped (3593)**.

---

## E-01 — `vitest.setup.ts` stubbed eleven modules for every suite; nine were load-bearing for nothing

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
