# Phase 1 Financial Remediation — Handoff

**Branch:** `claude/vanta-financial-reconciliation-4mg1li` (pushed, unmerged, undeployed)
**Range:** `origin/main`..`2ab3c51` — 22 commits
**Date:** 2026-08-27

> **Nothing in this branch is live.** It is not merged, not deployed, and the two
> new sweeps are registered in the cron but only run once the branch ships. No
> production data, schema, or configuration was changed. Phase 2 — the production
> data remediation — is authored but **unexecuted** and awaits your approval.

---

## 1. Code changes

| Area | File | What changed |
|---|---|---|
| COGS | `src/lib/quote-order.ts` | `resolveUnitCostCents` — three-branch rule: dose cost wins; a product that HAS doses but no usable dose cost returns `null` (no parent fallback); a dose-less product may still use its parent cost. Stops the inherited EvoLabs parent figure being charged against margin. |
| COGS | `src/lib/system-status.ts` | COGS and margin health checks read the dose cost with the same fallback, so the dashboard and the order path agree. |
| Shipping expense | `src/lib/shipping-cost-repair.ts` *(new)* | Absence-based sweep: label bought + Shippo transaction present + `actual_shipping_cost_cents` null + **not voided** → re-read the settled rate and record it. |
| Shipping expense | `src/lib/admin-profit.ts` | `shouldWriteShippingAudit` dedup guard (compares the most-recent audit row only); `recordActualShippingCost` now reads `label_voided_at` itself and **refuses to write money on a voided label**, so no caller can bypass the guard. `source` narrowed to `"shippo" \| "manual"`. |
| Refunds | `src/lib/refund-effect-repair.ts` *(new)* | One scan repairs four refund effects: the refund amount itself, points reversal, redeemed-points restore, store-credit refund. |
| Silent failures | `src/lib/payment-webhook.ts` | `unsafeEffectAlert()` wired into 8 sites — every non-idempotent paid-order effect now raises a `critical` system alert instead of a swallowed `console.error`. The manual-lane inventory decrement **re-throws** after alerting so the completion latch stays unreachable. |
| Processor fee | `src/lib/admin-control-shared.ts` *(new)*, `admin-control.ts`, `admin-control-center-client.tsx` | The fee is adjustable and the Control Center now shows the rate **actually in effect** beside the input, so a saved 8% and a defaulted 2.9% are visually distinguishable. |
| Cron | `src/app/api/cron/sweep/route.ts` | Both sweeps registered in the keyed `JOBS` registry (keyed, not positional — a mis-ordered job cannot mislabel another's alert). |
| EvoLabs | `src/lib/sql/` | Deleted `load-evo-catalog.sql`, `load-evo-catalog-grouped.sql`, `product-costs-evo.sql`. Removed `product_cost_cents = excluded.product_cost_cents` from four `ON CONFLICT` clauses in `SETUP-run-all.sql` and `add-bacteriostatic-water.sql` so re-running setup can no longer clobber real landed costs. Fulfilment enum values removed. |

Diffstat: **31 files, +5131 / −395.**

---

## 2. Tests added

| File | Tests | Covers |
|---|---|---|
| `src/lib/cogs-fallback.test.ts` | 5 | the three-branch COGS rule, incl. a zero-cost dose still counting as "has doses" |
| `src/lib/shipping-cost-audit-dedup.test.ts` | 6 | audit-row dedup against the most recent row |
| `src/lib/shipping-cost-repair.test.ts` | 8 | sweep candidate selection, settled-rate read, `{scanned, repaired, failed}` |
| `src/lib/shipping-cost-void-repair.test.ts` | 6 | the voided-label re-charge, at both layers |
| `src/lib/refund-effect-repair.test.ts` | 18 | all four refund effects, both scan passes, paging, NULL-vs-0 |
| `src/lib/unsafe-effect-alerting.test.ts` | 6 | every alert site fires with the right type and severity |
| `src/lib/profit-settings-defaults.test.ts` | 4 | effective-rate display |
| `src/app/api/cron/sweep/route.test.ts` *(extended)* | 8 | both sweeps registered and reported under their own names |
| `src/lib/payment-webhook-dedupe.test.ts` *(extended)* | 17 | alert wiring incl. the re-throwing inventory site |
| `src/lib/system-status.test.ts` *(extended)* | 15 | dose-cost fallback in the health checks |

Every fix in the branch was written RED first, and each has at least one test that
goes red if the fix is reverted.

---

## 3. Mutation controls

Each sweep was proved against a deliberately broken variant before being accepted:

- **Shipping sweep** — removing the `label_voided_at` filter turns the void test red; removing the
  Shippo `SUCCESS` status check turns the failed-label test red; removing the dedup guard duplicates
  the audit row.
- **Refund sweep** — narrowing the window back to `refund_amount = 0` (dropping NULL) turns the
  legacy-row test red; restoring the `refunded_at = now()` write turns the re-dating test red;
  swapping `.is()` back to `.eq()` on a NULL row turns the "counted as repaired but matched nothing"
  test red.
- **Alerts** — deleting any one of the 8 alert calls turns its named test red; making the inventory
  site swallow instead of re-throw turns the latch test red.

---

## 4. Full-suite results (re-run and verified by me, not taken on report)

| Gate | Result |
|---|---|
| `npm test` | **264 passed / 9 skipped (273 files)**, **4196 passed / 78 skipped (4274 tests)**, exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | `✖ 44 problems (0 errors, 44 warnings)`, exit 0 — baseline was 42 warnings; the 2 new ones are unused `_alert` params in test doubles |
| `npm run build` | exit 0 |

The 9 skipped files are the DB-gated concurrency suites; they need `VANTA_TEST_DATABASE_URL`
pointed at a throwaway Postgres and were **not** run — see §9.

---

## 5. The 6 auto-repair effects, and why each is idempotent

You asked for 7; the correct number is **6**. Two effects moved out of this bucket during spec
review because the primary write was idempotent but a downstream effect was not.

| # | Effect | Why a retry cannot double-write — including downstream |
|---|---|---|
| 1 | `ensureCommissionRecord` | Refuses to regress a non-`pending` commission. A retry after a successful insert takes the UPDATE branch, which never reaches `notifyAmbassadorOfNewCommission` — so no second commission **and** no second email. The `commissions` mirror is an upsert on `order_id`. Already live. |
| 2 | `recordActualShippingCost` | Fixed-value UPDATE — writing the same settled cents twice yields the same row. Its one downstream, the `order_shipping_cost_audit` insert, was unconditional and *would* have duplicated; the dedup guard added in this branch is what makes this effect retry-safe. It now also refuses outright on a voided label. |
| 3 | Refund-amount recording | Fixed-value UPDATE, guarded on the old value, no downstream effect at all. |
| 4 | `reverseOrderPoints` | Guarded on an existing `points_ledger(order_id, reason='order_refund_reversal')` row. Its only downstream, `recordPointsLedgerEntry`, sits *behind* that guard, so the ledger entry cannot be written twice either. |
| 5 | `restoreRedeemedPoints` | Same shape — guard on `(order_id, 'order_refund_points_restore')`, downstream inside the guard. |
| 6 | `refundStoreCreditForOrder` | Explicit already-refunded guard before the credit is issued. |

**The retry-storm argument.** Both sweeps are *absence-based*: they select rows by the absence of the
effect and stop finding them the moment it exists. There is no queue to lose an entry, no counter to
over-increment, and a second run of an already-repaired backlog scans and repairs nothing. That is why
this shape was chosen over the durable outbox originally specified — it needs no migration, so it fits
inside the Phase 1 wall, and it repairs the *existing* backlog rather than only future failures.

**The honest limit.** These guards are application-level SELECT-then-INSERT, not database unique
constraints. They are proof against **sequential** retries — the same job running again on the next
tick, which is the actual failure mode. They are **not** a proof against two sweeps running
*concurrently* on the same row. The database-level uniqueness that would close that gap is §C3, which
you deferred while other sessions were active. Until §C3 lands, do not run two sweep instances at once.

---

## 6. The 5 alert-only effects, and exactly why each remains unsafe

You asked for 4; the correct number is **5** — the inventory decrement moved here during review.

| Effect | Exactly why it is not retry-safe |
|---|---|
| **Inventory decrement (composite)** | `finalizeInventoryForOrder` alone *is* idempotent — it acts only on `active` reservations. But the block falls through to `decrementInventoryForOrder` whenever `fin.degraded \|\| fin.finalized === 0`: an unguarded `applyInventoryDelta(-qty)` loop with no order-scoped claim. That fallback fires in exactly the case worth retrying (an expired hold), so a retry double-decrements. Note the asymmetry: the RESTOCK direction has an exactly-once latch (`inventory_restocked_at`); the DECREMENT direction has none. Making this safe needs a per-order decrement claim — a schema change, deferred with §C3. |
| **`recordPointsLedgerEntry` (`order_earn`)** | Bare `INSERT` with no `(order_id, reason)` guard. A retry mints points a second time. |
| **`redeemStoreCredit`** | Bare insert, no guard. A retry debits the customer's credit twice. |
| **`redeemCoupon`** | Unconditional atomic increment of the redemption counter, and **no order linkage exists to guard on** — there is nothing to check absence against. A retry burns a redemption. |
| **`activatePaidMembership`** | Upserts the membership idempotently, then calls `recordBillingEvent({eventType:"renewal"})` as a bare `INSERT` — a retry duplicates a renewal in the billing ledger and re-sends the welcome email. It also recomputes `renews_at` from `now()`, shifting the billing period by the retry delay. |

All five now raise a `critical` alert naming the order, and surface in the admin queue. None is ever
auto-retried. Absence detection does **not** rescue them: check-then-act is not atomic and these five
have no convergence guard, unlike the six above.

---

## 7. Proposed production data changes — exact affected-row counts

**None of this has been executed.** The SQL is authored in
`src/lib/sql/phase2-financial-remediation.sql` (205 lines) and has never been run. Counts below were
re-measured read-only against production **today, 2026-08-27**, and are unchanged from the 2026-08-26
audit.

| § | Change | Rows | Reversible? |
|---|---|---|---|
| 1 | Create `order_cost_restatements` audit table (RLS on) | new table | drop it |
| 2 | Archive the three dead EvoLabs 3PL tables (CTAS, RLS on) | `fulfillment_orders` **2**, `fulfillment_payouts` **2**, `fulfillment_events` **194** | additive |
| 3 | **DESTRUCTIVE** — drop those three source tables, only after §2 verifies equal counts | same 2 / 2 / 194 | restore from the archives |
| 4 | Null the inherited EvoLabs parent costs — **only** for published products that HAVE doses | **38** | values captured nowhere; see §8 |
| 5 | cerebrolysin + pinealon → no cost on file (guarded on the exact value 3500) | **2** dose rows, **2** parent rows | re-enter the real cost when priced |
| 6 | Restate 4 order lines frozen at EvoLabs seed costs → landed costs | **4** (2456→383, 2520→768, 800→143, 3300→1066) | old value captured in the audit table first |
| 7 | Two **manual owner actions**, no SQL offered | see below | — |

**Section 7 — yours to do by hand:**

- **VL-E8F4D52F** shipped on a hand-entered UPS tracking number (`1Z0037BB0313242143`) with no Shippo
  transaction. Its real postage is not recoverable by any query or API call, and the sweep cannot see
  it (no `label_purchased_at`). Enter the cost in **Admin → Orders → VL-E8F4D52F**. Per your
  instruction, no figure was invented and no SQL is offered.
- **Persist the 8% processor fee.** **Admin → Control Center → Profit** → set processing fee percent
  to 8 → Save. It is stored as an audit row, not a table column, so it must go through the UI.

**What the sweeps would do on their first production run, if you deploy them:**

- Shipping sweep: **2** candidate orders (VL-8D132452, VL-8847B157 — both have a live Shippo
  transaction, an unvoided label, and no recorded postage).
- Refund sweep: **0** candidates. There are currently **no refunded orders** in production, so this
  sweep is purely forward-looking today.

Re-verify every count immediately before executing anything — `orders` moved 18 → 19 during this
audit from ordinary live activity, so production is not static.

---

## 8. Rollback and recovery

**Code.** The branch is unmerged. Rollback before merge is `git branch -D`; after merge, revert the
merge commit. Nothing in it changes behaviour until deployed, with one exception worth naming: once
deployed, the two sweeps write to production on the 30-minute cron. Per your instruction they have
**not** been enabled for that; deploying is a separate decision.

**Phase 2, section by section:**

| § | Rollback |
|---|---|
| 1 | `drop table public.order_cost_restatements;` |
| 2 | Additive. To re-archive you must `drop table` the three `archive_*` tables first — `create table if not exists ... as select` silently keeps a stale archive and copies nothing, and the verify only compares counts. |
| 3 | Recreate from `archive_fulfillment_*`. **This is the only irreversible step if §2 was skipped**, which is why §2 runs first and its counts must match before §3 runs. |
| 4 | **Weakest rollback.** The 38 old parent costs are not captured anywhere before being nulled. Take a `products` snapshot first if you want a way back: `create table archive_products_precost as select id, slug, product_cost_cents from public.products where product_cost_cents is not null;` |
| 5 | Guarded on the value 3500, so re-running is a no-op. Reverse by re-entering the real landed cost when the two products are priced. |
| 6 | Fully reversible — the audit INSERT runs **strictly before** the UPDATE, and both are guarded on the old value, so a re-run is a no-op rather than a second restatement. Restore from `order_cost_restatements.old_cost_cents`. |

Run section by section, checking each verification SELECT before proceeding.

---

## 9. Still NOT VERIFIED

- **Browser verification did not happen.** There is no `.env` in this workspace and
  `/api/admin/auth/login` returns 500, so the Control Center fee display (§Task 7) was verified by
  build + unit test only, never in a browser. `CLAUDE.md` asks for browser verification on
  customer-facing changes; this one is admin-facing, but it is still a gap.
- **The 9 DB-gated concurrency suites did not run.** They need `VANTA_TEST_DATABASE_URL` on a
  throwaway Postgres and cover double payout, exactly-once payout claim, the auto-approve race,
  inventory return path, partner identity convergence, invite atomicity, status integrity, and the
  bulk-savings rollup. Nothing in this branch is covered *only* by them, but the concurrency claims
  in §5 would be stronger with them green.
- **True-concurrency idempotency is unproven.** See the honest limit in §5. Sequential retry is
  proven; simultaneous sweeps are not.
- **FIN-03 — sales tax — remains an open, high-priority production/compliance finding.** It was
  deliberately excluded from this implementation because another audit lane owns tax and
  configuration. It is unresolved and it is **not** fixed by anything in this branch.
- **§C3 — financial-ledger unique indexes — deferred** at your instruction while other sessions were
  active. This is the recommended hardening follow-up, and it is what would close the concurrency gap
  and let the 5 alert-only effects become auto-repairable.
- **`staging-seed.sql`** and `SETUP-run-all.sql`'s `price_cents = excluded.price_cents` clauses were
  **not** fixed. Only the `product_cost_cents` clobbering was removed. A setup re-run can still
  overwrite live prices.

---

## 10. Production boundary — confirmation

No production data, schema, or configuration was changed by this lane. Re-verified read-only today:

| Check | Expected | Measured 2026-08-27 |
|---|---|---|
| Published products with a stale parent cost | 38 (unchanged) | **38** |
| Order lines still at the EvoLabs seed cost | 4 (unchanged) | **4** |
| `fulfillment_events` | 194 (unchanged) | **194** |
| `archive_*` tables | 0 (nothing archived yet) | **0** |
| `order_cost_restatements` table | does not exist | **does not exist** |
| cerebrolysin/pinealon rows at 3500 | 2 dose + 2 parent | **2 + 2** |

No SQL from `phase2-financial-remediation.sql` was executed. No migration was applied. No
configuration was changed. No deployment was made. `orders` moved 18 → 19 during the audit window
from ordinary customer activity, not from this lane — every query issued here was a `SELECT`.
