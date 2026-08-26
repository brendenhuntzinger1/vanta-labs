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

---

## F-02 — The fourth copy of the total formula HAS drifted, by exactly one cent

**Grade:** `BEHAVIORAL-TEST-PROVEN` (differential sweep against the real pricing pass) ·
**Severity:** P3 (bounded and currently absorbed) · **Status:** DOCUMENTED + hardened; one latent trap fixed

### The question, and how it was answered

`orders.amount_paid` is computed in one place (`quote-order.ts`);
`reconciliation-math.expectedOrderTotal` re-derives it from the stored columns
by hand. Nothing had ever compared the two — `reconciliation-math.test.ts` is a
sound Tier-B test, but it checks the copy against hand-computed values, so it
would pass unchanged if quoteOrder's formula moved underneath it.

`src/lib/reconciliation-drift.test.ts` runs the **real `quoteOrder`**, hands its
result to the **real `buildOrderRow`**, and reconciles the **real row**. No
formula is restated in the test, so a disagreement can only come from the two
implementations. 14 named baskets plus a 600-basket seeded sweep.

### Verdict: drifted, bounded, currently harmless

| | quote-order.ts | reconciliation-math.ts |
|---|---|---|
| Rounding | to the cent at **4** intermediate steps | **once**, at the end |
| Clamps | `Math.max(0, …)` twice | none |
| `handling_fee` | writes it (always 0) | **did not read it** |

The two orders of operations land **exactly one cent apart** on a minority of
baskets — observed, not theorised. The gap never exceeded one cent across 600
baskets, and `isTotalMismatch`'s ±$0.01 band absorbs exactly one cent, so **no
correctly-priced order is falsely flagged today**.

That band was documented as being about unrecorded protection fees. Nobody knew
it was also load-bearing for rounding drift. Tightening it to an exact
comparison — a plausible future "make the check exact" change — would start
flagging real orders on the one screen an operator opens when they already
suspect a problem. Both sites now say so, and the test **fails if the gap ever
reaches two cents**, which is the point at which it would false-flag.

### The one thing that was actually broken

`expectedOrderTotal` ignored `handling_fee`. Every writer sets it to 0
(`quote-order`, `membership-billing`, `admin-replacements`), so the column is
inert — but it is `not null default 0`, the customer invoice renders a Handling
line from it, and the first order to carry one would have been reported as
overpaying by exactly that amount. Now read, and covered end-to-end against
real Postgres.

### Negative controls — all seven caught

| # | Mutation | Result |
|---|---|---|
| D1 | recon drops the protection term | 8 failed |
| D2 | recon drops the card fee | 15 failed |
| D3 | recon flips the discount sign | 3 failed |
| D7 | recon drops the tax term | 17 failed |
| D4 | quoteOrder stops charging the card fee | 15 failed |
| D5 | quoteOrder stops adding protection | 8 failed |
| D6 | quoteOrder stops clamping store credit at the order total | 1 failed (the zero-total test) |
| R3 | `expectedOrderTotal` drops `handling_fee` | 1 failed |

**D3 escaped the first version of this suite.** Every basket had
`discount_amount = 0` — bulk savings are applied by reducing unit prices, not by
filling that column — so flipping the sign of a term that is always zero changed
nothing. Fixed by adding member-discount, store-credit and points cases, and by
a coverage guard that fails if the sweep ever stops exercising a term. A
differential suite whose inputs leave three of seven terms at zero is a
placebo for those three.

### Not verified

Store credit and points are exercised through mocked membership perks, not
through the real `getMembershipPerks` against a database. The **terms** are
exercised; the perk resolution behind them is Block D/K's.

---

## F-03 — Sales tax: a partial refund vanished, and a full refund produced a negative liability

**Grade:** `BEHAVIORAL-TEST-PROVEN` (real Postgres) · `DATABASE-PROVEN` (production has none yet) ·
**Severity:** P1 — this is the figure filed with a state revenue department · **Status:** FIXED

### Two defects, in opposite directions

**(a) `partially_refunded` disappeared entirely.** The only refund test in the
file was `const refunded = status === "refunded"`, and `partially_refunded` is
in neither that comparison nor `PAID_ORDER_STATUSES` — so the order fell through
`if (!paid && !refunded) continue` and never reached the report.
`orders.refund_amount` was not read anywhere in the file.

Reproduced: a $100 order carrying $6.00 of PA tax, half refunded → **zero rows**.
The store still owes the state the tax on the half the customer kept.

> **This corrects the audit map.** `PHASE1-SYSTEM-MAP.md` predicted the full
> `tax_amount` would be counted as collected (over-remitting). The opposite
> happens: the order is dropped and the store **under**-reports. The direction
> matters — it changes who is owed what, and an over-remittance is a refund
> claim while an under-remittance is a liability.

**(b) A fully refunded order produced `netTax = −$6.00`.** A refunded row was
added to `taxRefunded` and never to `taxCollected`, so the summary reported the
state owing the store money. The money was collected and then returned; both
movements belong in the summary and their difference is zero.

### Fix

Refunds are prorated on the order total in one function
(`refundedProportionOf`), with the assumption written down, so an accountant who
wants apportionment against the taxable base instead has one line to change.
Clamped to `[0, 1]` so a duplicated or mistyped refund cannot become a credit
the state never gave. A `refunded` order counts as fully refunded whatever
`refund_amount` holds — a chargeback reaches that status with the column
possibly still 0.

### OWNER DECISION — proration base

The refund is one dollar figure against the order; nothing records how it split
between merchandise, shipping, the card fee and the tax. Prorating on the order
total is the conventional approximation and the only one the stored data
supports. **If the owner's accountant wants refunds apportioned against the
taxable base (`subtotal − discount`), say so and it is a one-line change.**

### Negative controls — all five caught

| # | Mutation | Result |
|---|---|---|
| T1 | `partially_refunded` falls out of the report again | 3 failed |
| T2 | a partial refund treated as a full collection (the map's prediction) | 3 failed |
| T3 | a full refund booked only as a refund, never a collection | 4 failed |
| T4 | remove the `[0, 1]` clamp | 1 failed |
| T5 | a `refunded` row with `refund_amount = 0` stops counting as full | 1 failed |

### Current exposure

Production has **0 partially-refunded orders and 0 refunded orders**, so nothing
filed to date is wrong. It fires on the first refund. The admin refund route
(`api/admin/orders/[orderId]/route.ts:348`) writes exactly that status.

**Correction to the map's row-cap claim:** `getSalesTaxReport` already pages
(20 × 1000). It is not row-capped at 1,000; it stops silently at 20,000.

---

## F-04 — The customer's invoice does not add up, on three real orders today

**Grade:** `DATABASE-PROVEN` (production rows) · `BEHAVIORAL-TEST-PROVEN` · `BROWSER-PROVEN` (rendering) ·
**Severity:** P2 · **Status:** FIXED

### Reproduction — live production data, read-only

The totals block rendered Subtotal, Discount, Shipping, Handling, Tax, then
"Total paid". It never read `card_processing_fee` or `shipping_protection_fee`,
and `getCustomerOrderDetail` did not even select them.

| Order | Rendered lines | "Total paid" | Unexplained gap |
|---|---|---|---|
| VL-37C1E4B0 | $17.00 | $17.08 | **$0.08** |
| VL-8D132452 | $18.80 | $18.95 | **$0.15** |
| VL-E8F4D52F | $73.84 | $76.04 | **$2.20** |

VL-E8F4D52F shows `$54.99 + $15.00 + $3.85` and then declares **Total paid
$76.04**. This is the document a customer forwards to their accounting
department. No card order exists yet, so the 3% surcharge half of the defect has
not reached a customer; the protection half has.

Store credit and points were missing too, in the other direction — an order
redeeming either had lines summing to *more* than the total.

### Fix

The line list moves into `src/lib/invoice-totals.ts`: testable without rendering
HTML, and one place that decides what an invoice says. Anything the named fields
cannot explain becomes an explicit **"Other charges"** line rather than a silent
gap, so the arithmetic always holds even on a row written before a column
existed.

### Negative controls — all five caught

| # | Mutation | Result |
|---|---|---|
| I1 | drop the Shipping Protection line | 2 failed |
| I2 | drop the Service Fee line | 1 failed |
| I3 | drop the Store credit line | 1 failed |
| I4 | drop the residual line | 1 failed |
| I5 | `account-orders` stops selecting the four columns | 3 failed |

I1–I3 are caught **only because the tests also assert `"Other charges"` is
ABSENT** on orders whose parts are fully known. Without that, the residual line
would silently absorb every omission — the same defect through a new door.

### Verification

- 4 behavioural tests against real Postgres, driving the real
  `getCustomerOrderDetail`.
- **Browser:** the real route handler rendered for VL-E8F4D52F, served over
  HTTP, checked at **390×844**. Lines read $54.99 + $15.00 + $2.20 + $3.85 =
  **$76.04**. No layout breakage, no horizontal scroll, no console errors (the
  only entry is a 404 for `favicon.ico` from the throwaway static server).
- Full suite, `tsc` and `eslint` clean.

### NOT VERIFIED

The route's **authentication and ownership** path was stubbed for the render.
`getCustomerOrderDetail` is one of three hand-rolled ownership implementations
(map, GAPS-AND-SEAMS) and is **Block I's** to exercise. This finding covers the
arithmetic and the rendering only.

---

## F-05 — Two money reads could show part of the store and say nothing

**Grade:** `BEHAVIORAL-TEST-PROVEN` (real Postgres, generated volume) ·
**Severity:** P1 · **Status:** FIXED

### (a) Reconciliation could not see past 2,000 orders

`getReconciliationFlags` read `.limit(2000)` ordered newest-first, with no paging
and no truncation signal.

**Reproduced:** 2,101 orders, one of them underpaid by **$114** and older than
the rest → `getReconciliationFlags()` returned an **empty array**. This is the
screen an operator opens when they already suspect a money problem.

### (b) The profit tile depended on a setting the app cannot read

`profitForPaidOrdersInRange` — behind the 30-day profit tile and the analytics
trend — had **no `.limit()` and no `.range()` at all**. That is worse than a cap,
not better: the figure rested entirely on PostgREST's `db-max-rows` being unset,
a Supabase project setting this application cannot see, whose documented default
is 1,000.

**Reproduced:** 1,500 orders with a 1,000-row cap → the tile reported **1,000
orders and a third less profit**, with no error and no warning.

### Fix

Both page, and compare what they read against a **`count`** query — one round
trip, not subject to the cap — so they either get everything or say they did
not (`scan_truncated` flag / `truncated: boolean`). Paging also defeats
`db-max-rows` outright whenever the page size fits under it, because the cap
applies **per response, not per table** — a distinction the previous single
unbounded read could not exploit.

### Negative controls — all caught

| # | Mutation | Result |
|---|---|---|
| R1 | revert reconciliation to the single `.limit(2000)` | "a broken order older than the newest 2000…" |
| R2 | remove the truncation notice, keep the paging | "says so when it could not examine every order" |
| R4 | make `isTotalMismatch` always return false | 2 failed (incl. "still catches a genuine underpayment") |

Plus the converted exposure tests in `admin-profit-at-scale.test.ts`, which now
include a negative control that the `truncated` flag is not simply always true.

### CROSS-BLOCK

`truncated` is exposed on `ProfitWindowMetrics` and `ProfitDashboard` but is
**not yet rendered**. `src/app/admin/page.tsx` and
`src/app/admin/revenue/page.tsx` should show a warning when it is set — left to
consolidation rather than edited here, to avoid colliding with another session.

### NOT VERIFIED

**The actual `db-max-rows` value on the production project.** It is not a
role-level setting (`pg_db_role_setting` is empty for `pgrst%`), and this session
has no Supabase API credentials to read the project's API settings. The repair
makes the value irrelevant — the figures are correct either way, and say so if
not — but the setting itself remains unread. Owner can check it under
**Settings → API → Max rows**.

---

## Cross-block observations (recorded, not acted on)

**CROSS-BLOCK: express vs card checkout charge different totals for the same
cart.** `api/checkout/express/authorize/route.ts:283` writes
`amountPaid = intent.amount_cents + lockedShippingCents + lockedTaxCents`, where
`intent.amount_cents` is `quoteA.addressIndependentCents` — a quote taken in
`address_optional` mode, where shipping and tax are 0. So the express card fee is
charged on merchandise only, while the card lane charges it on merchandise +
shipping + tax. An Apple Pay customer pays roughly `cardFeePercent × (shipping +
tax)` less than a card customer for an identical basket (~$0.94 at 5% on $15
shipping + $3.85 tax). The express row still *reconciles* — `expectedOrderTotal`
agrees with what was charged — so this is **Phase 4 (checkout/payments)**, not
Phase 10, and is recorded here only because F-02's analysis surfaced it.

**CROSS-BLOCK: `orders.ambassador_credit_redeemed_cents` has no writer.**
`grep -rn ambassador_credit_redeemed_cents src --include=*.ts` returns nothing
outside the schema. Dead column — Block K (dead/dormant code).

**CROSS-BLOCK: `/admin/revenue`'s `approvedPayments` count** (`.eq("payment_status","paid")`,
head-count) still includes replacements. It is labelled as a *payments* count
rather than an orders count, so it was left alone deliberately; consolidation
should decide whether a $0 reship is a "payment".
