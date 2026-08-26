# BLOCK F — Financial reporting

Phase 10. Owner of `admin-profit.ts`, `admin-revenue.ts`, `admin-reconciliation.ts`,
`reconciliation-math.ts`, `admin-tax-report.ts`, plus the customer invoice route
that nobody mapped.

Branch: `claude/audit-blocks-f-e-8jxi9v`, from
`origin/claude/audit-superpowers-playwright-extension-c2oyhm`.
This file is merged into the ledger by the consolidation session (block M); no
verdict is written here and neither shared ledger file is edited.

Grades use the ledger's scale (`FINAL-CERTIFICATION-AUDIT.md` § Evidence grades).

---

## How Block F was reproduced

Production holds **15 orders, 0 replacements, 0 partial refunds** (read-only
query, 2026-08-26). Every defect in this block is about *which rows a report can
see*, so at that size four of the five are invisible and one is already live.

Two things made reproduction possible:

1. **A throwaway Postgres of its own** (`vanta_block_f`, port 55440 — never
   shared with another suite, per Rule 5). Seeded with generated orders, so a
   row cap or an `order_type` filter has something to hide.
2. **`src/lib/e2e/pg-supabase-adapter.ts`** (new) — a supabase-js-shaped client
   over real Postgres. An in-memory fake cannot prove anything about which rows
   a report sees, because the fake *is* the row source under test. It also runs
   `admin-dashboard-rollups.sql` verbatim, which no test had ever executed.

Negative controls use `scripts/mutate.sh` (new): apply one mutation, run a test
selection, restore the file from a byte copy. It restores from a **copy, not
`git checkout`** — a fix under test is usually uncommitted, and reverting to
HEAD silently deletes it and then reports that the tests "caught" a mutation of
code that no longer existed. That happened once here before the runner was
corrected; every result below was re-run against the corrected runner.

---

## F-01 — Three surfaces labelled "paid orders" report three different numbers

**Grade:** `BEHAVIORAL-TEST-PROVEN` (real Postgres, real rollup SQL) ·
`DATABASE-PROVEN` (production row counts) ·
**Severity:** P1 · **Status:** FIXED in repo; one migration awaiting the owner

### Reproduction

`src/lib/admin-financial-surfaces.test.ts`, against a real Postgres seeded with
**100 product sales at $100, 2 membership sales at $50, 3 reshipments at $0**.
A reshipment (`admin-replacements.createReplacementOrder`) writes a real orders
row at `payment_status='paid'`, `amount_paid=0`, `order_type='replacement'`.

The truth is 102 sales for $10,100. Before the fix:

| Surface | Function | Reported "orders" | Reported AOV |
|---|---|---|---|
| `/admin` lifetime tile | `getProfitDashboard` | **102** ✅ | correct |
| `/admin` + `/admin/revenue` 30-day tile | `getProfitWindowMetrics` | **105** ❌ | — |
| `/admin/revenue` headline | `getRevenueMetrics` | **105** ❌ | **$96.19** (true: $99.02) |
| `/admin/revenue` by-method chart | `admin_revenue_by_method` | phantom `replacement` row | — |

All three render as "N paid orders" in the UI
(`src/app/admin/revenue/page.tsx:69,78`, `src/app/admin/page.tsx:73`).
Three reships in 105 rows understated average order value by **2.9 %**; the
error scales linearly with the reship rate.

### Root cause

There was no canonical answer to "is this order a sale?", so four places
answered it independently:

- `admin-profit.getProfitDashboard` — excluded replacements, and its docblock
  explains exactly why ("100 sales plus 3 reships reports 103 orders and drags
  average order value down").
- `admin-profit.getProfitWindowMetrics` — 250 lines *earlier in the same file* —
  `ordersLast30Days += 1`, unconditional.
- `admin_revenue_summary` / `admin_revenue_by_method`
  (`sql/admin-dashboard-rollups.sql`) — no `order_type` filter at all, while the
  file's own header claims each function "mirrors the JS logic it replaces
  EXACTLY".
- `admin-revenue`'s JS fallback (the branch that runs when the migration has not
  been applied) — no filter either.

`ledger.ts` exists for precisely this — its header says it is "the single source
of truth every report, dashboard, and aggregation MUST use so no two surfaces
ever disagree" — and it had no predicate for this question.

### Fix

Smallest change that removes the duplication rather than adding a fifth copy:

- `ledger.ts` — new `NON_SALE_ORDER_TYPES` + `isSaleOrder()`. Purely additive.
- `admin-profit.ts` — both counters call `isSaleOrder`; the dashboard's inline
  string comparison is replaced by the same call, so there is one rule, not two.
- `admin-dashboard-rollups.sql` — both revenue functions exclude
  `order_type='replacement'`.
- `admin-revenue.ts` — the JS fallback applies the same exclusion, so the number
  no longer depends on whether the migration has been applied.

A `membership` is deliberately **not** excluded: it is a real paid sale that
merely never ships. Every *other* `order_type` filter in the repo excludes
`membership` (25 occurrences, all fulfillment-related), and copying that habit
into the revenue counts would erase real revenue. A test pins this.

### Negative controls — all six caught

| # | Mutation | Caught by |
|---|---|---|
| M1 | `getProfitWindowMetrics`: drop the `isSaleOrder` guard | "every surface counts the same 102 sales" (105 ≠ 102) |
| M2 | `admin_revenue_summary`: drop the SQL exclusion | same test + "average order value is not dragged down…" (2 failed) |
| M3 | `admin_revenue_by_method`: drop the SQL exclusion | "the revenue-by-method breakdown has no line for reshipments" |
| M4 | `NON_SALE_ORDER_TYPES` also excludes `membership` | 4 tests failed (100 ≠ 102) — over-reach is pinned |
| M5 | `admin-revenue` JS fallback: drop the exclusion | **only** "counts the same 102 sales when the rollup migration has NOT been applied" |
| M6 | `getProfitDashboard`: count reships as sales | 2 tests failed |

M5 is the one that matters most: it is caught by exactly one test, which proves
that test is not redundant with the RPC-path tests.

### Verification

- 5 new behavioural tests pass against real Postgres.
- Full suite green afterwards: **3573 passed, 12 skipped, 0 failed** (204 files).
- Production data unchanged — reads only.

### Owner action required

`src/lib/sql/admin-dashboard-rollups.sql` must be re-applied to production for
`/admin/revenue`'s RPC path to pick up the fix. **Not applied** — Rule 4.
Until then the JS fallback is correct and the RPC path keeps over-counting; the
app is correct either way *only* if the RPCs are absent. The file is
`create or replace` throughout and safe to re-run. Rollback: re-apply the
previous version of the same file.

### Discovered while fixing — a placebo that could not fail

`src/lib/replacement-economics.test.ts` "the dashboard counts sales and
reshipments separately" asserted that `admin-profit.ts` *contained the literal
string* `String(row.orderType ?? "").toLowerCase() === "replacement"`. It went
**red on a behaviour-preserving refactor** and would have stayed **green on the
exact defect its own comment describes** — `orderCount += 1` for replacements,
with the literal left anywhere in the file. Replaced with real assertions
against `isSaleOrder` plus a pointer to the behavioural coverage. Carried into
Block E as E-01.
