# BLOCK F-A — Financial reporting (session `claude/block-ab-audit-o62bop`)

> ## ⚠ FOR THE MASTER INTEGRATION AUDIT (Block M) — recheck every pagination test
>
> `src/lib/e2e/fake-db.ts` implemented PostgREST's `range()` as
> `range() { return builder; }` — **a stub that discarded its arguments**. Any
> suite that asserted on a paged read through that fake could not have been
> testing the paging: the fake returned the same rows for every page.
>
> Fixed here (F-A-18), but the consequence is wider than Block F: **until now, any
> assertion about a paged read made through this fake was passing for a reason
> unrelated to whether the paging worked.** Two separate paging helpers existed
> in `src/lib/` at the same time, and neither was exercised end to end.
>
> Concrete worklist — every test file that touches a paged read:
>
> | File | Status |
> |---|---|
> | `src/lib/supabase-page.test.ts` | pre-existing; simulates the cap directly, does NOT use the fake — sound, but see F-A-19 for the hole it encodes |
> | `src/lib/supabase-page-bounded.test.ts` | added by Block F |
> | `src/lib/admin-profit-at-scale.test.ts` | rewritten by Block F; its fake now models a per-response cap |
> | `src/lib/financial-reporting-row-caps.test.ts` | added by Block F; real Postgres |
> | `src/lib/financial-reporting-consistency.test.ts` | added by Block F; real Postgres |
> | `src/lib/e2e/commerce-journey.test.ts` | uses `fake-db`; passed only after the `range()` fix — **recheck** |
> | `src/lib/e2e/manual-reimbursement.test.ts` | uses `fake-db`; same — **recheck** |
> | anything else importing `@/lib/e2e/fake-db` | **recheck** |
>
> Also: **Block C** owns the three callers of `supabase-page.readAllRows`
> (`admin-email.ts`, `email/audience.ts`, `marketing-broadcast.ts`). F-A-19 is a
> latent truncation in that helper that would silently shorten a **suppression
> list** — i.e. mail people who unsubscribed. Not changed from here.

Scope per [`AUDIT-PARALLEL-ASSIGNMENTS.md`](../AUDIT-PARALLEL-ASSIGNMENTS.md):
`admin-profit.ts`, `admin-revenue.ts`, `admin-reconciliation.ts`,
`reconciliation-math.ts`, `admin-tax-report.ts`, plus `order-profit.ts` and
`sql/admin-dashboard-rollups.sql`.

Branch: `claude/block-ab-audit-o62bop`. Findings are namespaced `F-xx` per
Rule 2; the ledger is not edited from here.

---

## The owner's decisions, and where each one now lives

Recorded verbatim because they resolve questions the reports had been answering
inconsistently, and because every surface is now asserted against them.

**1. A partial refund keeps its retained revenue.** A $200 order refunded by $50
is $150 of revenue, and it is still an order.

| Surface | Before | Now |
|---|---|---|
| `admin-profit` (dashboard, 30-day, per-order) | counted it | counted it — unchanged |
| `admin-revenue` RPC + JS fallback | **excluded it entirely** | counts it; refund netted off the money |
| `admin_customer_rollup` | summed **gross** `amount_paid` | nets the refund off |
| `admin_ops_summary` live sales | gross, `paid` only | net, over revenue statuses |
| `admin-tax-report` | **dropped it entirely** (F-A-05) | counts it; proportional tax refund |
| `admin-reconciliation` | already examined every status | unchanged — it checks the original charge, which is correct |

The definition now has one home: `ledger.REVENUE_ORDER_STATUSES` and
`ledger.netOrderRevenue`, mirrored in SQL and held in step by
`ledger-sql-parity.test.ts`.

**2. Collected sales tax is not revenue or profit.** It is a liability held on
behalf of a state.

- `DEFAULT_PROFIT_CONFIG.countSalesTaxAsProfit` is now `false`.
- **A code default is not enough** — see
  [`BLOCK-F-PRODUCTION-CHANGES.md`](./BLOCK-F-PRODUCTION-CHANGES.md) §2. The
  Control Center writes this key on every save, so a stored `true` overrides it.
- Tracked, not merely excluded: `ProfitDashboard.salesTaxCollected` and
  `salesTaxCountedAsProfit` are the liability line, and the sales-tax report is
  the filing view of the same money.
- F-A-12 is what makes this setting *safe* to turn on: before it, a refund
  deducted tax from revenue it had never been added to.

**3. `revenue − discounts − refunds − COGS − processor fees − shipping = profit.`**

Asserted end to end in `financial-reporting-consistency.test.ts`, over a
nine-order ledger, against arithmetic derived independently of the modules.

Two notes on the formula as written:

- **Discounts are already inside revenue.** An order records
  `subtotal − discount_amount`, so revenue is post-discount and discounts are
  not deducted a second time.
- **Ambassador commission is also deducted**, and it is not in your formula. It
  is a real cost the store pays on a referred sale, so leaving it out would
  overstate profit — but flagging it because it is a deliberate addition to what
  you specified, not an oversight. Say the word if you want it reported as a
  separate line rather than an expense.

---

## The evidence base: a real database with 21,000 orders

Production has **fifteen orders**. Every row cap in this block sits between
2,000 and 20,000, so production cannot exercise a single one of them — and
neither can a fake, because a fake that truncates proves only that the fake
truncates.

So the five modules were run **unmodified** against a real Postgres 16 cluster
seeded with 21,000 orders, through a shim that translates their query-builder
calls into SQL and imposes **no ceiling of its own**
(`src/lib/e2e/postgrest-shim.ts`). The caps under test are in the application,
not in the harness: the shim passes `.limit(n)` through to SQL `LIMIT n`.

    initdb + pg_ctl on 127.0.0.1:55432   (isolated, ephemeral, not the harness)
    VANTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
      npx vitest run src/lib/financial-reporting-row-caps.test.ts

The dataset is generated by one `INSERT … SELECT generate_series` so the
expected counts are arithmetic rather than measurement. 21,000 orders, one per
minute descending, of which per thousand: one fully refunded, one partially
refunded, one `$0` replacement, one membership, one never paid. Six orders are
deliberately short by `$27` — one inside the newest 2,000 and five far outside.

**Ground truth, straight from SQL:**

| | |
|---|---|
| orders | 21,000 |
| `payment_status in (paid, completed, succeeded)` | 20,937 |
| `partially_refunded` | 21 |
| `refunded` | 21 |
| orders carrying tax that also carried money | 20,937 |
| tax on those | `$167,496.00` |
| revenue net of refunds (paid + partial) | `$2,657,199.00` |

**What the five surfaces reported before any fix:**

| Surface | Reported | Truth | Silent about it? |
|---|---|---|---|
| reconciliation `total_mismatch` | 1 flag | 6 broken orders | yes |
| profit dashboard `orderCount` + `replacementCount` | 19,940 + 20 | 20,937 + 21 | yes |
| profit dashboard `lifetime.grossRevenue` | `$2,531,820` | full history | yes |
| profit `ordersLast30Days` | 20,958 | — (counts reships) | yes |
| revenue via RPC | 20,937 / `$2,655,582` | 20,937 | — |
| revenue via JS fallback | 10,000 / `$1,268,369` | 20,937 / `$2,655,582` | yes |
| sales tax rows | 19,960 | 20,937 | yes |
| sales tax collected | `$159,520` | `$167,496` | yes |
| sales tax net | `$159,360` | `$167,261.85` | yes |

Not one of them raised an error, set a flag, or logged a warning.

---

## F-A-01 — The reconciliation screen cannot see a mismatch older than 2,000 orders

**Grade:** `DATABASE-PROVEN` (21,000 rows, real Postgres) · **Severity:** P1 · **Status:** FIXED

**Reproduction.** Six orders recorded `amount_paid = 100.00` against components
implying `127.00`. `getReconciliationFlags()` returned exactly one
`total_mismatch`: `order-000010`. The other five — `order-005000`,
`order-008000`, `order-012000`, `order-016000`, `order-020000` — were queried
directly out of the same database, confirmed still short by `$27`, and were not
in the result.

**Root cause.** `admin-reconciliation.ts` read with a single
`.limit(2000)` ordered by `created_at desc`. Anything past the newest 2,000
orders was never examined.

This is the screen an operator opens *because* they already believe the ledger
is wrong, and it answers "no problems found".

**Fix.** Paged to exhaustion through `readAllRows`
(`src/lib/supabase-paging.ts`), with `order_id` added as a tiebreaker so paging
over a non-unique `created_at` can neither repeat nor skip a row.

**Test.** `financial-reporting-row-caps.test.ts` — "reconciliation flags every
mismatched order, not just the newest 2,000".

**Negative control.** `MAX_RECONCILIATION_ORDERS` set back to `2000` → that
test alone fails, on the mismatch list. Restored → passes.

---

## F-A-02 — The profit dashboard truncates lifetime figures at 20,000 orders

**Grade:** `DATABASE-PROVEN` · **Severity:** P1 · **Status:** FIXED

**Reproduction.** With 20,958 profit-eligible orders present,
`getProfitDashboard()` reported `orderCount` 19,940 and `replacementCount` 20 —
19,960 of 20,958 — and `lifetime.grossRevenue` of `$2,531,820`. Every lifetime
figure on `/admin` (gross revenue, net profit, gross and net margin, average
order value, average profit per order) is computed from that slice and presented
as the store's whole history.

**Root cause.** `.limit(MAX_DASHBOARD_ORDERS)` with `MAX_DASHBOARD_ORDERS =
20000`, and nothing that compares the rows received against the rows that exist.

**Fix.** Paged to exhaustion. `ProfitDashboard` gained a `truncated: boolean`
so that reaching the (now 200,000) ceiling is *reported* rather than absorbed.
The field is additive — no admin page needed changing.

**Test.** "the profit dashboard counts the whole order history, not the newest
20,000", asserting against a SQL ground-truth query using the dashboard's own
predicate.

**Negative control.** `MAX_PROFIT_ORDERS` → `20000` fails that test (and F-A-05's).

---

## F-A-03 — The revenue page reports two different lifetime totals depending on whether one migration has run

**Grade:** `DATABASE-PROVEN` · **Severity:** P1 · **Status:** FIXED

**Reproduction.** Same data, same function, both paths exercised in one test by
declaring the RPCs missing on the second call:

    via admin_revenue_summary   20,937 orders   $2,655,582
    via the JS fallback         10,000 orders   $1,268,369

A 52% under-report of lifetime revenue, and nothing on the screen distinguishes
which number you are looking at.

**Root cause.** The fallback was a single `.limit(10000)`. Its own comment
described the cap as a known limitation ("Run the migration to remove the cap at
scale") — but the migration is not a precondition for the page rendering, so the
capped path is a live path.

**Fix.** The fallback pages to exhaustion, ordered by `id` for stable
pagination. Both paths now answer with the same total; the fallback is slower,
not smaller. The stale comment was corrected.

**Test.** "the revenue fallback caps at 10,000 orders while the RPC path does
not" — now asserting the two agree on orders, revenue and AOV.

**Negative control.** `MAX_REVENUE_ORDERS` → `10000` fails exactly that test.

---

## F-A-04 — The sales-tax filing report stops after 20 pages

**Grade:** `DATABASE-PROVEN` · **Severity:** P1 · **Status:** FIXED

**Reproduction.** 20,937 orders carried tax and money. The report returned
19,960 rows and `$159,520` collected against `$167,496` actually charged —
`$7,976` of collections simply absent from a document whose output is the number
the owner writes on a state return.

**Root cause.** `for (let page = 0; page < 20; page += 1)` at `pageSize = 1000`.
A hard 20,000-row ceiling, with `break` on a short page and no signal on the
20th.

**Fix.** Paged to exhaustion; `SalesTaxReport` gained `truncated: boolean`.

**Test.** "the sales-tax report covers every taxed order past the old 20-page
ceiling", asserting row count and total against SQL.

**Negative control.** `MAX_TAX_ORDERS` → `20000` fails exactly that test.

---

## F-A-05 — A partially refunded order was absent from the sales-tax return entirely

**Grade:** `TEST-PROVEN` + `DATABASE-PROVEN` · **Severity:** P1 · **Status:** FIXED

**Root cause.** The old filter was:

```ts
const paid = PAID_ORDER_STATUSES.has(status);
const refunded = status === "refunded";
if (!paid && !refunded) continue;
```

`PAID_ORDER_STATUSES` is `{paid, completed, succeeded}` (`ledger.ts:21`).
`partially_refunded` is in neither set and is not the string `"refunded"`, so it
failed both halves and hit `continue`. It is a real status, written by both the
webhook (`payment-webhook.ts:161`) and the admin refund path
(`api/admin/orders/[orderId]/route.ts:348`).

The customer kept most of the goods; the state kept the tax; the order was not
on the return.

**Fix.** `partially_refunded` is counted as a collection.

**Test.** `admin-tax-report.test.ts` — "counts a partially refunded order, which
used to disappear entirely".

**Negative control.** Removing `partiallyRefunded` from the `collected`
predicate fails exactly that test.

---

## F-A-06 — A refund was deducted from net tax without its collection ever being recorded

**Grade:** `TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED

**Root cause.** In the per-state rollup, a refunded row incremented
`taxRefunded` but was routed around `taxCollected` by an `if (row.refunded)`
branch. `netTax = taxCollected − taxRefunded` then came out one full tax amount
too low per refunded order — and a state whose only taxed order was refunded
reported a **negative amount due**.

Visible in the 21,000-row run: California showed `taxCollected` `$79,360`,
`taxRefunded` `$160`, `netTax` `$79,200`. The correct net is `$79,360`:
`$160` was collected on those orders and `$160` came back.

**Fix.** Collected and refunded are separate lines on a return, and every taxed
order belongs on the first one. Both are now accumulated for every row.

**Tests.** "a fully refunded order nets to zero, not to minus its own tax"; "a
state whose only taxed order was refunded never reports negative tax due".

**Negative control.** Restoring the `if (!row.refunded)` branch fails four of the
six tests in that file.

---

## F-A-07 — Partial refunds had no proportional tax treatment

**Grade:** `TEST-PROVEN` · **Severity:** P2 · **Status:** FIXED (with a stated assumption)

Nothing in the schema records the tax portion of a refund. `refund_amount` is
the total dollars returned against `amount_paid`, which includes tax
(`payment-webhook.ts:171-174`, and the admin path's `newRefundTotal`).

**Fix.** `refundedTaxFor()` derives the refunded tax as
`tax × min(1, refund_amount / amount_paid)`, capped at the tax charged. A full
refund gives a ratio of exactly 1, which unifies the two cases. Two edge cases
are handled explicitly:

- a row marked `refunded` with **no** recorded `refund_amount` (predating that
  column being written) is trusted on its status and refunds the whole tax;
- a `refund_amount` recorded **above** `amount_paid` is capped, so a data error
  already flagged by reconciliation cannot become a negative tax liability.

**Assumption, stated because a filing depends on it:** that a refund of part of
a sale returns that same proportion of its tax. This is the ordinary treatment,
but it is *derived*, not recorded. If a partial-refund tax column is ever added,
`refundedTaxFor` is the function it replaces — the code says so at the call site.

**Negative controls.** Dropping the `Math.min` cap fails "never refunds more tax
than was collected"; removing the status fallback fails "trusts the status when
a refunded row carries no refund_amount".

---

## F-A-08 — `reconciliation-math.expectedOrderTotal` agrees with the charged formula. The map's implied defect is DISPROVED.

**Grade:** `TEST-PROVEN` (differential sweep) · **Severity:** — · **Status:** DISPROVED, with two latent risks recorded

[`PHASE1-SYSTEM-MAP.md:1202`](../PHASE1-SYSTEM-MAP.md) flags
`expectedOrderTotal` as "a fourth independent re-derivation" of `quoteOrder`'s
`amount_paid` formula, and the assignments file repeats it as a lead. It is
indeed a fourth hand-written copy. **It is not currently wrong.**

`reconciliation-math-differential.test.ts` transcribes the charged formula from
`quote-order.ts` — staged and clamped exactly as written, with line numbers —
and sweeps every combination of subtotal, shipping, tax, discount, protection,
card fee, store credit and points redemption that checkout can actually produce.
The two agree to the cent on all of them, with and without redemption.

Reporting this as a defect without running it would have been wrong. Two real
risks remain, and both are **LATENT**:

- **`handling_fee` is omitted.** `expectedOrderTotal` has no handling term.
  Every writer sets `handling_fee: 0` (`quote-order.ts:967`,
  `membership-billing.ts:193,470`, `admin-replacements.ts:161`) and
  `quote-order.ts:507` states outright that no handling fee is ever charged. But
  two customer-facing surfaces already *display* it —
  `order-confirmation/[orderId]/page.tsx:85` and `account-orders.ts:166` — so
  the column is live in the receipt and dead in the reconciliation. The first
  order that carries a non-zero handling fee is flagged as a mismatch.
- **The clamps differ.** `quoteOrder` clamps at every stage
  (`quote-order.ts:751,754,770,777`), so a charged total can never fall below
  protection plus card fee. `expectedOrderTotal` subtracts flat and can return a
  **negative** expected total. At quote time the clamp never binds — the
  discount is capped at the subtotal by
  `profit-engine.ts:221` (`round(Math.min(subtotal, bestEffective))`) and each
  redemption is capped at the balance due. It would take a writer that changes
  `subtotal`, `discount_amount`, `store_credit_redeemed_cents` or
  `points_redeemed` *after* insert. Whether such a writer exists is under
  verification; the divergence is characterised in the test either way, because
  the two are not the same function.

**Recommendation (not applied):** the durable fix is one shared total function
rather than a fifth copy — but `quote-order.ts` is a Rule-3 shared file, so this
is recorded, not edited. See CROSS-BLOCK below.

---

## F-A-09 — Two order counts in `admin-profit.ts` disagreed with each other

**Grade:** `DATABASE-PROVEN` · **Severity:** P2 · **Status:** FIXED

`getProfitDashboard` deliberately excludes `order_type = 'replacement'` from
`orderCount`, and its docblock explains why: a reship has no buyer, so counting
it "reports 103 orders and drags average order value down with three $0
denominators". `getProfitWindowMetrics`, in the same file, did
`ordersLast30Days += 1` unconditionally.

At 21,000 orders with every row inside the 30-day window, the 30-day tile
reported **20,958** and the lifetime tile **19,940** for the same store, on the
same page.

**Fix.** The 30-day count applies the same rule, with the reason stated inline.

**Test.** "the 30-day order count and the lifetime order count agree on what a
sale is".

**Negative control.** Restoring the unconditional increment fails exactly that
test.

---

## F-A-10 — `admin-reconciliation` carried a fifth hand-copy of the points redemption rate

**Grade:** `TEST-PROVEN` · **Severity:** P3 · **Status:** FIXED

`points_redeemed` is stored in points. The conversion to dollars was a hardcoded
`/ 100`, while `points-math.ts:5` exports `POINTS_PER_DOLLAR_REDEMPTION = 100`
and `pointsToDollars()` is what `quoteOrder` charges on.

They agree today, so nothing was wrong. The rate is an exported constant, which
is the shape of a value someone is expected to change — and on the day it
changes, the copy flags **every** points-redeeming order as a mismatch on the
screen the owner opens to find real ones.

**Fix.** Calls `pointsToDollars`.

**Test.** `admin-reconciliation-points-rate.test.ts` mocks the rate to 200 and
asserts a points-redeeming order is not flagged, and that a genuinely wrong
total still is.

**Negative control.** Restoring the hardcoded `/ 100` fails both tests.

---

## F-A-11 — Nothing detected a short read from the row source

**Grade:** `TEST-PROVEN` (modelled) · **Severity:** P1 · **Status:** FIXED — and the question it depended on is now moot

`profitForPaidOrdersInRange` had no `.limit()` and no `.range()`, which is not
the same as being unbounded: PostgREST caps every response at its `db-max-rows`
(Supabase exposes it as "Max rows"). A capped read came back looking exactly
like a small store.

A previous session raised this as an exposure in
`admin-profit-at-scale.test.ts` and deliberately changed no code, because the
setting could not be read from this environment. **It still cannot** — this
container has no Supabase credentials, and a role-level check only rules out a
role-level override.

**So the setting was made irrelevant instead of measured.** `readAllRows` stops
only on an **empty** page, never a short one, and advances the offset by the
rows it actually *received*. A cap therefore costs round trips, not accuracy.

**Test.** "MODEL: a db-max-rows cap no longer changes any reported number", run
with a cap of **750** — deliberately not a multiple of the page size, so every
response arrives short without the source being exhausted. That is precisely the
case a "stop when the page is short" reader gets wrong.

**Negative controls.** Two, both on `supabase-paging.ts`: stopping on a short
page, and advancing the offset by the page size rather than by rows received.
Each fails exactly that test.

The previous session's exposure tests were rewritten in place to hold the
defence rather than the exposure, and its fake was taught to model a
per-**response** cap (which paging can defeat) rather than a source that has
lost rows (which nothing can).

---

## F-A-12 — A refund removed sales tax from profit that was never added to it

**Grade:** `TEST-PROVEN` · **Severity:** P1 (on a setting the business is heading for) · **Status:** FIXED

**Reproduction.** `computeOrderProfit` on a fully refunded $127 order
(`$100` merchandise, `$10` shipping, `$8` tax, `$9` card surcharge):

    countTaxAsProfit = true    grossRevenue 127   revenue   0    profit  -6
    countTaxAsProfit = false   grossRevenue 119   revenue  -8    profit -14

**Root cause.** `order-profit.ts:228` was `revenue = grossRevenue − refund`.
`refund` is everything handed back, **tax included**. Whether the tax is inside
`grossRevenue` depends on `countTaxAsProfit`
(`order-profit.ts:227`). With the toggle on, the two cancel and a full refund
nets to zero — correct. With it off, tax was never added, so subtracting the
whole refund removes tax that was never there. Every refunded order then
reports negative revenue equal to its own tax, and profit that much worse than
the truth. `marginPercent` guards on `revenue > 0` and reports **0%**, so the
negative revenue does not even show up as an obviously broken margin.

`countSalesTaxAsProfit` is an admin toggle (`admin-control.ts:602-605`:
"True = the owner keeps it (counted as profit); false = it's a pass-through
remitted to the state"). It defaults to `true`, which is why this has never
been seen. This store runs a real sales-tax remittance report — pass-through is
the accounting posture it is heading for, not a hypothetical.

**Fix.** `OrderProfitInput` gained an optional `refundedTax`, and the reversal
became `countTaxAsProfit ? refund : max(0, refund − refundedTax)`. The default
path is byte-identical — `refundedTax` is unused when tax counts as profit.
`admin-profit.profitForOrder` supplies it via `refundedTaxPortion()`, which
derives the tax share of a refund the same way `admin-tax-report.refundedTaxFor`
does, so the profit report and the filing report cannot disagree about the same
refund.

**Tests.** `order-profit-refund-tax.test.ts`, 5 cases including "is unchanged
when tax counts as profit" (the no-op proof on the default path).

**Negative controls.** Three: reverting to subtracting the whole refund fails 3
of 5; dropping the `min(taxCollected, …)` cap fails the over-refund case;
applying the adjustment when tax IS counted fails the no-op proof.

---

## F-A-13 — The degraded checkout insert blanks the tax jurisdiction the filing report groups by

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN — CROSS-BLOCK, root cause is outside this block

**Root cause, confirmed line by line.** `quote-order.buildOrderRow` returns two
rows. `baseOrderRow` (`quote-order.ts:946-983`) carries `tax_amount`.
`orderRowWithContact` (`:991-1005`) adds `state`, `phone`, `billing_*`,
**`tax_rate_percent`** and **`tax_state`**. `insertOrderRow` (`:1028-1053`)
retries with `draft.base` — the row *without* those columns — when the insert
returns `PGRST204`, or when the message mentions one of those columns and looks
like a missing column.

An order written through that fallback therefore has `tax_amount > 0` with
`tax_state`, `tax_rate_percent` and `state` all NULL. `admin-tax-report` then
does exactly this:

```ts
const state = order.tax_state ?? normalizeUsState(order.state) ?? "UNKNOWN";
ratePercent: Number(order.tax_rate_percent ?? 0),
```

So the collection lands in an `UNKNOWN` jurisdiction bucket **at a reported rate
of 0%**, on a document filed with a state revenue department. Nothing logs,
alerts, or records that the fallback fired — there is no `recordSystemAlert`
call anywhere on that path.

**Reachability is not limited to a missing migration.** `PGRST204` alone
triggers the fallback, and `PGRST204` is what PostgREST returns for a column
absent *from its schema cache* — which happens transiently after a migration,
before the cache reloads. A cache-reload lag can therefore blank a window of
orders on a fully migrated database.

**Mitigating.** `UNKNOWN` does surface as its own row in `byState`, sorted with
the rest, so the money is visible on the admin page. It is the **rate** that
silently reads 0%, and the per-order CSV detail line that carries it.

**Why not fixed here.** The root cause is the silent degradation in
`quote-order.ts`, a Rule-3 shared file. Papering over it in the report would
make the tax report *look* fine while orders continue to be written without
their jurisdiction. Recorded as CROSS-BLOCK.

---

## F-A-14 — Manual postage entry finalizes profit while the order page and the generated column stay blank

**Grade:** `SOURCE-INSPECTED` · **Severity:** P2 · **Status:** OPEN — CROSS-BLOCK

Confirms [`PHASE1-SYSTEM-MAP.md:403`](../PHASE1-SYSTEM-MAP.md).

Three surfaces read three different columns for one number:

| Surface | Column |
|---|---|
| `admin-profit` shipping overlay | `actual_shipping_cost_cents` |
| admin order page "Postage" (`admin/orders/[orderId]/page.tsx:138`) | `postage_cost_cents` |
| `orders.shipping_profit_cents` (GENERATED, `shippo-orders-sync.sql:121-126`) | `postage_cost_cents` only |

`recordActualShippingCost` (`admin-profit.ts:546`) writes **only**
`actual_shipping_cost_cents`, `estimated_shipping_cost_cents`,
`shipping_cost_source`, `shipping_cost_updated_at` and `profit_finalized`. The
admin manual-correction action `set_shipping_cost`
(`api/admin/orders/[orderId]/route.ts:689-700`) is a caller of exactly that.

So after an owner enters the real postage by hand: profit reports **Finalized**
on the exact figure, `shipping_profit_cents` stays **NULL forever** (a stored
generated column can only be recomputed by writing its source), and the order
page shows no postage at all — its whole `label` block is gated on
`shippoTransactionId && !labelVoidedAt` (`page.tsx:130`), which a
manually-corrected order does not have.

**Not a defect:** the `Math.max(0, …)` clamp at `admin-profit.ts:571`. The route
already rejects anything outside `$0–$10,000` before calling
(`route.ts:694`), so the clamp cannot manufacture a `0` from a negative. A
genuine `$0` entry is accepted and asserted as a finalized real cost, but that
is an operator entering zero, not the code inventing it.

**Why not fixed here.** The write path and the admin page both sit outside Block
F's files. Recorded as CROSS-BLOCK.

---

## F-A-15 — The two "processing fee percent" constants agree, and are two concepts. DISPROVED as a live defect.

**Grade:** `SOURCE-INSPECTED` · **Severity:** P3 · **Status:** DISPROVED, one risk recorded

[`PHASE1-SYSTEM-MAP.md:727`](../PHASE1-SYSTEM-MAP.md) flags "TWO different
concepts with near-identical names". Both exist and both are `8`:

- `admin-control.DEFAULT_PROFIT_CONFIG.processingFeePercent = 8`
  (`admin-control.ts:625`) — the fee the STORE PAYS its processor. Read at
  runtime by `admin-profit.processingFeeFor` via `getProfitSettings()`, so the
  admin-configured value wins and the constant is only a fallback.
- `profit-engine.DEFAULT_PROFIT_SETTINGS.processingFeePercent = 8`
  (`profit-engine.ts:50`) — the same concept, used only as the **default
  argument** of `protectProfit(inputs, settings = DEFAULT_PROFIT_SETTINGS)`
  (`profit-engine.ts:291`). Every production caller passes real settings.

Neither is `orders.card_processing_fee`, which is the surcharge the CUSTOMER was
charged — and `admin-profit` treats that correctly, as *revenue*
(`additionalRevenue`), never as the store's cost.

**Risk recorded, not raised to a finding:** they are two literals that must
never drift. If the admin raises the processor fee, `protectProfit`'s default
still says 8 — which only matters for a caller that omits settings, and none
does today.

---

## F-A-16 — Reachability of the `expectedOrderTotal` clamp divergence (F-A-08)

**Grade:** `SOURCE-INSPECTED` · **Status:** LATENT — no writer found

F-A-08 left open whether any path mutates `orders.subtotal`,
`orders.discount_amount`, `orders.store_credit_redeemed_cents` or
`orders.points_redeemed` **after** insert, which is what would be needed to make
the flat-subtraction divergence produce a false `total_mismatch`.

Searched `src/app/api/admin/**`, `src/lib/payment-webhook.ts` and
`src/lib/admin-*.ts`. The post-insert writers to `orders` touch payment status,
refund amount and timestamps, fulfillment status, tracking and shipping-cost
columns — **not** the four component columns. No such writer was found.

The divergence therefore stays **LATENT**, and is characterised in
`reconciliation-math-differential.test.ts` rather than reported as a defect. The
reason to keep it on the record is that it is one writer away, and the writer
that adds it will have no reason to suspect the reconciliation screen.

---

## F-A-17 — The COGS read is the one that returns many rows per order, and it was undefended

**Grade:** `TEST-PROVEN` · **Severity:** P2 · **Status:** FIXED

`costLinesByOrderId` (`admin-profit.ts`) asks for the line items of **150
orders in one `.in()`**, unbounded. One row per order is the assumption; the
table holds one row per *line item*. An order averaging seven lines is over a
thousand rows in a single response.

This is the same defect class as F-A-01…F-A-04 with the **opposite sign**: losing
order rows makes profit look smaller, and someone eventually notices. Losing
line-item rows removes **product cost**, so profit looks *better* than it is.
Nobody goes looking for that.

The sibling reads are safe and now say so in a comment: `commissionByOrderId`
and `shippingOverlayByOrderId` return at most one row per order, so a chunk of
150 cannot exceed any plausible cap.

**Fix.** Paged, ordered by `id`.

**Test.** `admin-profit-at-scale.test.ts` — "does not lose product cost to a cap
on the line-item read", asserted against the arithmetic
(`$115 − $40 − $9.20 − $9 = $56.80` an order) rather than against the uncapped
run, so it cannot pass by both runs losing COGS together.

**Negative control.** Capping the line-item read at 100 rows fails that test
**and** the file's existing "gets the money right, to the cent". The first
version of this test used a loose bound and did **not** fail under that
mutation — the negative control is what caught it, and the assertion was
tightened.

**Recorded, not fixed:** `costLinesByOrderId` ignores the query error entirely
(`const { data } = await …`). A transient failure on that read yields an empty
map, which computes **zero COGS** and reports profit inflated by the whole
product cost, indistinguishable from an order genuinely having no items.
Changing it means choosing between failing the dashboard and degrading to the
worst-case unit cost — a behaviour decision, so it is on the record rather than
made unilaterally here.

---

## F-A-18 — The shared e2e fake ignored `range()`, so it could not model paging at all

**Grade:** `TEST-PROVEN` · **Severity:** P2 (test-infrastructure fidelity) · **Status:** FIXED

`src/lib/e2e/fake-db.ts` implemented `range()` as `range() { return builder; }`
— a stub that discards its arguments. Harmless while every caller read in one
shot; not harmless once the reporting modules page, because **a source that
ignores the range returns the same page forever**.

Caught by the fix in F-A-17: five tests across `commerce-journey.test.ts` and
`manual-reimbursement.test.ts` went red with COGS of `7,200,000` against an
expected `36` — the pager accumulating the same rows up to its ceiling.

Those tests were not wrong. The fake was: it could not truncate, so it could not
model the thing paging exists to survive.

**Fix.** `range(from, to)` now records the bounds and slices after ordering and
limit, matching PostgREST's inclusive Range semantics. Three lines, no test's
meaning changed, all 111 tests in those two files pass unmodified.

`fake-db.ts` is harness infrastructure rather than a `*.test.ts` file, so this
is inside Block F's remit — but **Block E should know**, since it is
mutation-testing suites that run on this fake, and until now any suite asserting
on a paged read was passing for the wrong reason.

---

## F-A-19 — The pre-existing paging helper stops on a short page, which is only safe while max-rows is exactly 1000

**Grade:** `SOURCE-INSPECTED` + `TEST-PROVEN` (the alternative is proven) · **Severity:** P2 · **Status:** OPEN — CROSS-BLOCK (Block C owns the callers)

**I duplicated before I found it.** `src/lib/supabase-page.ts` already existed,
already exported `readAllRows`, and was already used by `admin-email.ts`,
`email/audience.ts` and `marketing-broadcast.ts`. Block F added a second
`supabase-paging.ts` exporting a function of the same name. Two paging helpers
in one directory is exactly the hand-copy problem this block spent its time
writing up, so the duplicate is gone and both now live in `supabase-page.ts`.

Reading the incumbent turned up a real hole. Its loop is:

```ts
const from = index * PAGE_SIZE;              // fixed stride
const { data, error } = await page(from, from + PAGE_SIZE - 1);
if (rows.length < PAGE_SIZE) return all;     // short page means finished
```

Its docblock states the assumption plainly: *"The page size is deliberately
equal to the default cap: asking for exactly what the server is willing to give
makes 'a short page means the end' true."*

That holds **only while Supabase's max-rows is exactly 1000.** It is a project
API setting, this module cannot observe it, and if it is ever set **below** the
page size then every page arrives short and the loop returns after the first
one. The fixed stride compounds it: the next request would start a full
`PAGE_SIZE` on, skipping whatever the cap held back.

**Why that matters more than it sounds.** The module's own docblock names the
stakes: *"a truncated read of `email_suppressions` does not fail, it just stops
mentioning some of the people who unsubscribed, and the next campaign mails
them."* The helper written to prevent that failure can still produce it.

**What Block F did instead of changing it.** Added `readAllRowsBounded` beside
it, which stops only on an **empty** page, advances by the rows actually
received, and reports hitting its ceiling. The four financial modules use that.
`readAllRows` is untouched — its callers were written against its contract, and
changing termination semantics under another block's code mid-audit is not this
block's call. All eight of its existing tests pass unmodified.

**CROSS-BLOCK for Block C / Block M:** the three email callers should move to
the bounded variant, or `readAllRows` should adopt its termination rule. The
cost either way is one extra request per read.

**Tests.** `supabase-page-bounded.test.ts`, 9 cases, including a source capped
at 250 (below the page size) and one at 337 (not a multiple of it).

**Negative controls.** Three, each on the new loop: stopping on a short page
fails 3 tests; striding by page size instead of rows received fails the same 3;
assuming truncation at the ceiling instead of probing fails the exact-fit case.

---

## F-A-20 — The two database-backed suites shared one database and one `orders` table

**Grade:** `TEST-PROVEN` · **Severity:** P2 (test infrastructure) · **Status:** FIXED

Both Block F database suites open with `drop table if exists orders; create
table orders …`, and vitest runs files in parallel. Run together they dropped
each other's data mid-test.

The symptom was not a clean error. `financial-reporting-row-caps` reported
20,958 where it expected 20,937 — a plausible-looking wrong number, which is the
same failure mode as everything else in this block.

`AUDIT-PARALLEL-ASSIGNMENTS.md` Rule 5 names `src/lib/e2e/suite-database.ts` for
exactly this and it did not exist. It does now: `createSuiteDatabase(baseUrl,
suite)` drops and recreates a database named for the suite, so each gets its own.
Available to every other block with a database-backed suite.

**Verification.** Both suites pass together; the full run with a database
attached is **3,624 passing, 0 skipped**.

---

## F-A-21 — The row-caps suite carried its own hand-copy of the revenue SQL

**Grade:** `TEST-PROVEN` · **Severity:** P2 · **Status:** FIXED

`financial-reporting-row-caps.test.ts` defined `admin_revenue_summary` and
`admin_revenue_by_method` inline, as retyped copies of the migration. When the
owner's partial-refund decision changed the real SQL, the test kept creating the
old definition — so the RPC path and the JS fallback disagreed inside the test,
and it failed.

It failed for the right reason, and the fix is the one this block keeps
reaching for: **stop copying the definition.** Both database suites now read the
function bodies out of `src/lib/sql/admin-dashboard-rollups.sql` itself, so they
exercise the SQL that ships.

---

## CROSS-BLOCK

Recorded per Rule 3, not edited from this block.

- **`src/lib/quote-order.ts`** — `expectedOrderTotal` is the fourth hand-copy of
  the `amount_paid` formula and `handling_fee` is the fifth term it omits. The
  durable fix is one exported pure total function that both checkout and
  reconciliation call. Shared file; not touched. (F-A-08)
- ~~`src/lib/sql/admin-dashboard-rollups.sql` — partially refunded revenue~~
  **RESOLVED by the owner.** Retained revenue counts. Both paths changed
  together; the migration is listed in
  [`BLOCK-F-PRODUCTION-CHANGES.md`](./BLOCK-F-PRODUCTION-CHANGES.md) §1 and has
  **not** been applied.
- **`src/lib/supabase-page.ts` callers (Block C)** — `admin-email.ts`,
  `email/audience.ts`, `marketing-broadcast.ts` use `readAllRows`, whose
  short-page termination is only safe while max-rows is exactly 1000 (F-A-19). A
  truncated suppression-list read mails people who unsubscribed.
- **`src/lib/partner-portal.ts` `getAdminOperationsSummary` (Block A+B)** — the
  JS twin of `admin_ops_summary`. The SQL now sums NET revenue over the revenue
  statuses; if that reduce still sums gross `amount_paid`, the two disagree the
  way `admin-revenue`'s two paths used to.
- **`src/lib/quote-order.ts`** (second entry) — `insertOrderRow`'s `PGRST204`
  fallback silently writes an order with no `tax_state` and no
  `tax_rate_percent`, which the filing report then reports as an `UNKNOWN`
  jurisdiction at a 0% rate. The fix belongs on the write path: either do not
  degrade those two columns, or `recordSystemAlert` when the fallback fires so
  the blanked window is knowable. (F-A-13)
- **`src/app/api/admin/orders/[orderId]/route.ts` + `src/app/admin/orders/[orderId]/page.tsx` + `src/lib/sql/shippo-orders-sync.sql`**
  — one shipping cost, three columns. A manual postage entry finalizes profit
  while `postage_cost_cents` (and therefore the generated
  `shipping_profit_cents`, and the order page's Postage line) stays empty.
  (F-A-14)

---

## NEEDS THE OWNER

**Answered** — retained revenue counts, and sales tax is a liability. See "The
owner's decisions" above and
[`BLOCK-F-PRODUCTION-CHANGES.md`](./BLOCK-F-PRODUCTION-CHANGES.md) for what has
to be applied.

Still open:

1. **Approve the migration and the one setting change.** Nothing has been
   applied. Read-only queries to size the impact first are in
   `BLOCK-F-PRODUCTION-CHANGES.md` §3.
2. **The project's Supabase "Max rows" setting.** No longer load-bearing for
   correctness after F-A-11, but worth knowing for request budgeting: it now
   determines how many round trips a full profit read costs.
3. **Confirmation of the proportional partial-refund tax treatment in F-A-07 and
   F-A-12**, since it is a filing assumption rather than a recorded value, and it
   now feeds the profit report as well.
4. **Should a failed COGS read fail the dashboard, or fall back to the
   worst-case unit cost?** Today it silently reports zero product cost (F-A-17).
5. **Should ambassador commission be an expense line or reported separately?**
   It is deducted as an expense today and is not in the formula as you wrote it.

---

## Summary

| | Findings |
|---|---|
| Fixed, with regression test + negative control | F-A-01…F-A-07, F-A-09…F-A-12, F-A-17, F-A-18, F-A-20, F-A-21 |
| Disproved (reported as leads, do not exist) | F-A-08, F-A-15 |
| Open, root cause outside Block F (CROSS-BLOCK) | F-A-13, F-A-14, F-A-19 |
| Latent, characterised not fixed | F-A-08 (handling_fee, clamps), F-A-16 |
| Needs the owner | 4 questions below |

## Verification

- Full suite with a database attached: **3,624 passing, 0 skipped, 0 failing**.
- Full suite without one: 3,602 passing, 22 skipped (the three database-backed
  suites skip loudly, naming the variable and the command to run them).
- Typecheck: clean (`npx tsc --noEmit`).
- Lint: clean on every file touched.
- The database suites are gated on `VANTA_TEST_DATABASE_URL`, each gets its own
  database (F-A-20), and they fail loudly rather than skipping if the cluster is
  reachable but broken — verified when the container reclaimed Postgres
  mid-session and the suite errored instead of quietly passing.
- Every fix above has a regression test **and** a recorded negative control
  naming which mutation breaks which test.

## NOT VERIFIED

- No browser verification. Block F is server-side reporting; the admin surfaces
  that render these numbers belong to Block I and the browser blocks.
- Nothing was run against production or the harness database. All 21,000 rows
  were in a local, ephemeral Postgres cluster created for this session.
