# Vanta Labs — Independent Financial, Data & Business-Logic Reconciliation

**Lane:** Financial reconciliation / database integrity / business logic (third independent audit lane)
**Posture:** READ-ONLY. No production code, data, migrations or configuration were modified. No orders,
customers, payments, commissions, referrals, labels or emails were created.
**Production database:** Supabase project `mlpimwgkwuqpsvsrlpqv`
**Data as at:** 2026-08-26 ~20:17 UTC
**Method:** every figure below was derived by querying production directly and recomputing the arithmetic
independently in SQL. The application's own helper functions were never used to produce an "expected" value.

> The audit harness project `vanta-audit-harness` (`snnezhxvssochqpqsjcm`) was deliberately **not** touched —
> it belongs to another active session.

---

## 0. Scope of the ledger being reconciled

| Table | Rows | Note |
|---|---:|---|
| `orders` | 18 | 6 paid, 3 pending_payment, 2 payment_failed, 5 canceled, 2 canceled membership |
| `order_items` | 20 | |
| `payment_events` | 10 | 6 paid |
| `products` | 46 | 38 published, 8 archived/unpublished |
| `product_doses` | 71 | 51 under published products |
| `coupons` | 367 | 335 auto-generated cart-recovery codes |
| `ambassadors` / `partners` | 8 / 8 | mirrored 1:1 |
| `referral_orders` / `commissions` / `payouts` | 0 / 0 / 0 | no commission has ever accrued |
| `customer_memberships` | 2 | both on a **deactivated** tier |
| `inventory_reservations` | 19 | 0 active at time of reading |

**Money actually captured, computed independently:**

```
SUM(amount_paid - refund_amount) WHERE payment_status = 'paid'  =  $232.38  across 6 orders  (AOV $38.73)
Product-only paid                                               =  $231.38  across 5 orders  (AOV $46.28)
SUM(amount_paid) across ALL 18 rows regardless of status        = $1,344.99                  (AOV $74.72)
```

That third line is the trap: `orders.amount_paid` is written **at order creation**, not at capture. A pending,
failed or canceled order carries a non-zero `amount_paid`. Any query that sums it without a status filter
overstates revenue by **$1,112.61 (479%)** on today's data. Every application surface audited does filter
correctly — but the column name invites the error.

---

## 1. FINDINGS

Severity: **CRITICAL** = money or legal exposure now · **HIGH** = wrong numbers on a surface an operator
trusts · **MEDIUM** = latent or reporting-level · **LOW** = hygiene.

---

### FIN-01 — Parent-level `product_cost_cents` is a placeholder 1.4×–6.8× the true dose cost, and is the COGS fallback
**SYSTEM:** COGS / profit · **SEVERITY:** HIGH · **CONFIRMED**

**EXPECTED:** A product's cost of goods reflects what the store pays for that item.

**ACTUAL:** For **36 of 38** published products, `products.product_cost_cents` (parent) is materially higher
than the true `product_doses.product_cost_cents` of its default dose. The parent values cluster on 3300 and
3500 — and `3300` is exactly `DEFAULT_PROFIT_CONFIG.worstCaseUnitCost` ($33.00). The parent column holds the
worst-case estimation constant, not a cost.

**DIFFERENCE:** (ratio = parent ÷ dose)

| slug | parent | dose (default) | ratio |
|---|---:|---:|---:|
| ghrp-2 | 3300 | 484 | **6.82×** |
| snap-8 | 3300 | 484 | **6.82×** |
| glp-1 | 2456 | 383 | **6.41×** |
| ghrp-6 | 3300 | 521 | 6.33× |
| ghk-cu | 2288 | 365 | 6.27× |
| epithalon | 3300 | 549 | 6.01× |
| bacteriostatic-water | 800 | 143 | 5.59× |
| … 29 more between 1.40× and 5.55× | | | |
| igf-1-lr3 | 3500 | 2396 | 1.46× |
| cerebrolysin / pinealon | 3500 | 3500 | 1.00× (never updated) |

**EVIDENCE:** `quote-order.ts:819-826` — `unitCostCentsForLine()` prefers the dose cost and **falls back to
the parent slug cost**. The same fallback drives `guardProductCost` (`quote-order.ts:~690`), the checkout
profit floor.

**BUSINESS IMPACT:** Any order line whose dose does not resolve is snapshotted at up to 6.8× its real cost —
understating that order's profit permanently. The same fallback tightens the checkout profit guard, so a
legitimately profitable order on a low-cost SKU can be refused with "Promotion unavailable on this order."

---

### FIN-02 — Four historical orders carry the inflated parent COGS; profit on paid orders is understated by $51.39
**SYSTEM:** COGS / historical profit · **SEVERITY:** HIGH · **CONFIRMED**

**EXPECTED:** `order_items.unit_cost_cents` is the store's real cost at checkout.

**ACTUAL:** Orders written before the dose-id fix carry a bare slug in `product_id` (no `::doseId`), so the
parent fallback fired and froze the placeholder cost onto the line.

| order | line | snapshot cost | true dose cost | overstatement |
|---|---|---:|---:|---:|
| VL-E8F4D52F (paid) | `glp-1` GLP-1 (5mg) ×1 | $24.56 | $3.83 | **+$20.73** |
| VL-8847B157 (paid) | `mots-c::…` MOTS-C (10mg) ×1 | $25.20 | $7.68 | **+$17.52** |
| VL-EA5529EF (paid) | `bacteriostatic-water` ×2 | $16.00 | $2.86 | **+$13.14** |
| VL-64F8EDE4 (pending) | `5-amino-1mq` ×1 | $33.00 | $10.66 | +$22.34 |

**DIFFERENCE:** Across the three **paid** orders: recorded COGS $65.76 vs true $14.37 → **profit understated
by $51.39**, against a total independently-computed profit of $113.73. That is **45%** of reported profit.

**EVIDENCE:** `order_items.product_id` values `glp-1`, `bacteriostatic-water`, `5-amino-1mq` carry no `::`
dose suffix; later rows (`b12::c8ea4006…`, `glp-3::55544dc9…`) do. Cutover falls between 2026-08-03 and
2026-08-09.

**BUSINESS IMPACT:** Historical profit is wrong in the conservative direction and cannot self-correct — the
snapshot is immutable by design (correctly so). These four rows need a deliberate, audited restatement, not a
code change.

---

### FIN-03 — Sales tax collection is switched off store-wide, including the store's own home state
**SYSTEM:** Tax · **SEVERITY:** CRITICAL · **CONFIRMED**

**EXPECTED:** Florida orders collect Florida sales tax. The business address on file is
`30929 Mirada Blvd, San Antonio FL 33576` (control key `email.marketing_postal_address`), which establishes
physical nexus in Florida.

**ACTUAL:** Control key `tax.nexus_states` is the **empty string**. `getSalesTaxSettings()`
(`admin-control.ts:500`) splits it to an empty array, and `resolveSalesTax()` (`sales-tax.ts:~200`) returns
`reason: "no_nexus"` for every destination. **No sales tax is collected anywhere.**

**DIFFERENCE:** The behaviour changed on 2026-08-23 (first `tax` control row: `2026-08-23 22:01:52`):

| order | date | ship state | subtotal | tax collected | rate |
|---|---|---|---:|---:|---:|
| VL-E8F4D52F | 08-02 | FL | 54.99 | 3.85 | 7.000% |
| VL-8847B157 | 08-03 | FL | 54.99 | 3.85 | 7.000% |
| VL-64F8EDE4 | 08-03 | ID | 99.99 | 6.03 | 6.030% |
| VL-EA5529EF | 08-07 | FL | 28.48 | 1.99 | 7.000% |
| VL-EB6E0751 | 08-09 | FL | 49.99 | 3.50 | 7.000% |
| VL-DCA0FAD5 | 08-09 | FL | 49.99 | 3.50 | 7.000% |
| **VL-8D132452** | **08-25** | **FL** | 3.80 | **0.00** | **0.000%** |
| **VL-37C1E4B0** | **08-25** | **FL** | 2.00 | **0.00** | **0.000%** |
| VL-B10D3E7A/DA402437/AD39DBEF | 08-26 | CA | 79.98–84.98 | 0.00 | 0.000% |

Note the tell: `orders.state` still records `FL`, but `orders.tax_state` is `NULL` on every post-08-23 row.

**EVIDENCE:** `admin_control_current` → `tax.nexus_states = ''`. `sales-tax.ts:137`
`DEFAULT_SALES_TAX_CONFIG.nexusStates = []`. Two **paid** Florida orders collected $0.00.

**BUSINESS IMPACT:** Uncollected Florida sales tax is a liability the store owes regardless of whether it
charged the customer. The amounts are trivial today ($0.41 on the two paid FL orders at 7%) precisely because
the only FL orders since the change were $2–$3.80 test-priced orders — but the setting is live and every
future FL order under-collects. The design choice that a **blank** field means "collect nowhere" is safe as a
first-run default and unsafe as the result of an admin saving a form.

> **REMEDIATION STATUS — UNRESOLVED. NOT fixed by the Phase 1 remediation branch.**
> FIN-03 was deliberately excluded from `claude/vanta-financial-reconciliation-4mg1li` at the owner's
> instruction, because tax and configuration are owned by a separate audit lane. It remains a
> **high-priority open production and compliance finding**. Nothing in the Phase 1 code changes, and
> nothing in the unexecuted Phase 2 SQL, restores tax collection. It needs an owner and a decision
> independently of this branch.

*Sub-point (SUSPECTED):* Idaho was charged at 6.030% on 2026-08-03. There is no plausible ID nexus for a
Florida store. The 6.03% figure is the built-in combined-average rate (`sales-tax.ts:56`), so the resolver ran
with ID in the nexus list at that time. No control row predates 2026-08-23, so the historical nexus list
cannot be recovered from the database and the cause is not determinable from data alone.

---

### FIN-04 — Shipping expense is never recorded; every shipped order's postage is a $6.00 model
**SYSTEM:** Shipping / profit · **SEVERITY:** HIGH · **CONFIRMED**

**EXPECTED:** After a Shippo label is purchased, the order records what the store paid the carrier.

**ACTUAL:** All three orders that shipped or bought a label have **every** shipping-cost column NULL:

| order | fulfilment | customer paid ship | est cost | actual cost | postage | source | shippo txn |
|---|---|---:|---:|---:|---:|---|---|
| VL-E8F4D52F | shipped | $15.00 | NULL | NULL | NULL | NULL | — (manual tracking) |
| VL-8847B157 | label_purchased | $15.00 | NULL | NULL | NULL | NULL | `2aaf020b7a4c…` |
| VL-8D132452 | label_purchased | $15.00 | NULL | NULL | NULL | NULL | `3a7fa84885e7…` |

`order_shipping_cost_audit` — the table meant to catch exactly this — has **0 rows**.
`shipping_profit_cents` is NULL on all three.

**DIFFERENCE:** With no actual cost, `admin-profit.ts:137-141` falls back to
`config.shippingCostPerOrder`. The control value `profit.shipping_cost_estimate` is **blank**, so the coded
default **$6.00** applies. Reported shipping profit is therefore a flat **$15.00 − $6.00 = $9.00** per order,
and no order can ever reach `profitStatus: "finalized"`.

**EVIDENCE:** `service.ts:1198` does write `postage_cost_cents: label.postageCostCents` — so the code path
exists. Whether the labels predate that code or Shippo returned a null amount is not determinable from the
data alone. The observable fact stands either way: two real labels, zero recorded postage.

**BUSINESS IMPACT:** Real cash paid to UPS is absent from the ledger. If actual postage on a 1.42–3.18 oz
parcel exceeds $6, profit is overstated on every shipped order, and the error grows with every shipment.

---

### FIN-05 — The deployed revenue rollup functions have drifted from the ledger definition they are supposed to mirror
**SYSTEM:** Revenue / AOV · **SEVERITY:** MEDIUM (defect CONFIRMED, dollar impact currently $0) · **CONFIRMED**

**EXPECTED:** `ledger.ts` declares the canonical revenue set as
`{paid, completed, succeeded, partially_refunded}` minus `order_type = 'replacement'`, and states:
*"MIRRORED IN SQL: src/lib/sql/admin-dashboard-rollups.sql."* `admin-revenue.ts` likewise claims replacements
are *"excluded here, the same exclusion the rollup function applies."*

**ACTUAL:** The function **actually deployed** in production is an older revision:

```sql
-- LIVE in production (pg_get_functiondef):
from public.orders where payment_status in ('paid','completed','succeeded')
-- missing: 'partially_refunded'
-- missing: and coalesce(order_type,'product') <> 'replacement'
```

```sql
-- src/lib/sql/admin-dashboard-rollups.sql (correct, in the repo):
where payment_status in ('paid','completed','succeeded','partially_refunded')
  and coalesce(order_type, 'product') <> 'replacement'
```

**DIFFERENCE:** Swept across every deployed rollup:

| deployed function | includes `partially_refunded` | excludes `replacement` |
|---|---|---|
| `admin_revenue_summary` | **no** | **no** |
| `admin_revenue_by_method` | **no** | **no** |
| `admin_customer_rollup` | yes | **no** |
| `admin_ops_summary` | **no** | **no** |
| `admin_partner_rollups` | **no** | **no** |
| `admin_points_outstanding` | **no** | **no** |
| `admin_bulk_savings_stats` | **no** | **no** |

**Not one deployed rollup excludes replacements.**

**EVIDENCE:** `pg_get_functiondef` on the live database vs the repo file, quoted above.

**BUSINESS IMPACT:** Today the dollar impact is **$0** — production contains no replacement order and no
partially-refunded order, and I verified both definitions return the identical `$232.38 / 6 orders / AOV
$38.73`. The moment the first reshipment or partial refund exists, the dashboard silently diverges: a
replacement adds a $0 denominator to AOV (the exact bug the code comments describe as fixed), and a partially
refunded order's retained revenue disappears. It also means the **RPC path and the JS fallback path return
different numbers**, so the headline figure depends on whether the RPC exists.

---

### FIN-06 — The parity test that guards FIN-05 validates a file on disk, never the database
**SYSTEM:** Reporting integrity · **SEVERITY:** MEDIUM · **CONFIRMED**

**EXPECTED:** "Changing one side alone fails here" (`ledger-sql-parity.test.ts`).

**ACTUAL:** The test does `readFileSync(path.resolve(__dirname, "sql/admin-dashboard-rollups.sql"))` and
compares the TypeScript constants to that **text**. It explicitly states *"It cannot execute the SQL, and it
does not try."* Both sides it compares are correct; the artefact that actually computes revenue in production
is a third thing neither side looks at.

**BUSINESS IMPACT:** This is the mechanism by which FIN-05 stayed invisible through a certification pass. Any
future rollup fix will be marked verified by a green test while production keeps running the old function.
The gap is *deployment verification*, not authorship.

---

### FIN-07 — The paid-order side-effect pipeline swallows every financial failure, latches once, and never retries
**SYSTEM:** Orders / commissions / inventory / coupons / refunds · **SEVERITY:** HIGH · **CONFIRMED**

**EXPECTED:** A financial write must not fail while the order is reported as fully processed.

**ACTUAL:** `payment-webhook.ts` claims a single-use side-effect token **before** running the side effects
(`const runSideEffects = Boolean(seClaim && seClaim.length > 0)`), then wraps each one in
`try { … } catch (e) { console.error(…) }` and continues. The claim is already spent, so nothing is retried.

Swallowed operations, card lane and manual lane:

| line(s) | operation | consequence if it fails |
|---|---|---|
| 1629 / 1112 | ambassador commission accrual | ambassador is never paid; order looks normal |
| 1795 | **inventory decrement** | stock never comes down — the same unit resells |
| 1648 / 1132 | coupon redemption count | single-use coupon stays redeemable |
| 1697 / 1168 | membership points | points never awarded |
| 1770 / 1223 | membership activation | customer pays, gets no membership |
| 1881 | **refund amount recording** | `refund_amount` unwritten → revenue never reduced |
| 1902 / 1907 | points reversal / restore | points ledger drifts from orders |
| 1912 | store credit return | customer's money not returned |
| 1931 | membership revoke on refund | refunded customer keeps entitlements |
| 1274 | `paid_side_effects_at` latch | a later cancel under-restocks |

**EVIDENCE — this class of failure has already occurred in production.** The code's own comment at
`payment-webhook.ts:747`:

> *"NOT NULL in production, with no default, and never sent until now — so EVERY accrual insert was refused
> with 23502 before it could even reach the payment_status CHECK. **Zero commissions exist in production as a
> result.**"*

That is a `console.error` in a serverless log, an order marked paid, and a commission that silently never
existed. `referral_orders`, `commissions` and `payouts` are all still empty. `recordSystemAlert` is called on
only one of these paths (line 1518); the rest reach nobody.

**BUSINESS IMPACT:** The highest-severity structural finding in this audit. Every one of these is real money,
each fails invisibly, and none is recoverable without a manual sweep.

---

### FIN-08 — The payment processor fee is an unverified 8% model, applied to the tax-inclusive total
**SYSTEM:** Processor fees / profit · **SEVERITY:** MEDIUM · **CONFIRMED**

**EXPECTED:** Processor cost is the fee the processor actually charged.

**ACTUAL:** Nothing in the system ever ingests a settled fee. `processingFeeFor()`
(`admin-profit.ts:73-81`) computes `amount_paid × processingFeePercent / 100`. Control key
`profit.processing_fee_percent` is **blank**, so `DEFAULT_PROFIT_CONFIG.processingFeePercent = 8` applies.
`profit.processing_fee_includes_tax = true`, so the fee is charged on the **full** amount including sales tax.

**DIFFERENCE:** Independently computed against the 6 paid orders: **$18.60** of modelled processor fee on
$232.38 of revenue. 8% is roughly 2.7× a typical card rate (~2.9% + $0.30). Whether 8% reflects this
processor's real economics could not be verified from any artefact in the repository or the database.

**EVIDENCE:** `orders.card_processing_fee = 0.00` on all 18 rows. That column is the **customer-facing
surcharge** (`payment_methods.card_processing_fee` = `{enabled: false, percentage: 0}`) — correctly zero,
and a different quantity entirely from the processor's cost.

**BUSINESS IMPACT:** The code is scrupulously honest about this — every surface labels it *"Payment processor
fee (estimated)"* and `processingFeeIsEstimate` defaults to `true`. But it is the second-largest expense line
after COGS and it is a guess. If 8% is too high, profit is understated by ~$12 per $232 of revenue; if too
low, overstated.

---

### FIN-09 — "Processing fees collected" and the profit page's processor fee are different quantities with similar names
**SYSTEM:** Revenue reporting · **SEVERITY:** LOW · **CONFIRMED**

`RevenueMetrics.processingFeesCollected` sums `orders.card_processing_fee` = **$0.00** (customer surcharge,
disabled). The profit page shows **$18.60** (modelled processor cost, FIN-08). Same vocabulary, opposite sign,
two orders of magnitude apart. An operator reading both screens has no way to know they are unrelated.

---

### FIN-10 — Collected sales tax is configured to count as profit
**SYSTEM:** Profit / tax · **SEVERITY:** MEDIUM · **CONFIRMED**

Control key `profit.count_sales_tax_as_profit = **true**` (set 2026-08-23). `order-profit.ts` documents the
opposite as the intended default: *"tax collected is remitted to the state, so it's a pass-through, not
earnings."*

**DIFFERENCE:** $9.69 of collected tax across the paid orders is inside reported profit
($3.85 + $3.85 + $1.99). At the same time the tax report treats that $9.69 as a filing liability. The profit
page and the tax report describe the same dollars in opposite directions.

This is a toggle the owner deliberately set, so it is *as configured* — but the economic consequence is that
reported profit includes money owed to a state, and the two reports will never agree.

---

### FIN-11 — Two orders' `amount_paid` exceeds the sum of their recorded components
**SYSTEM:** Order ledger · **SEVERITY:** LOW · **CONFIRMED**

Recomputing `subtotal + tax + cardFee + shipping + handling − discount − storeCredit − points + protection`
for all 18 orders, **16 reconcile to the cent**. Two do not:

| order | components | `amount_paid` | difference | 4% of subtotal |
|---|---:|---:|---:|---:|
| VL-64F8EDE4 | $121.02 | $125.02 | **+$4.00** | $4.00 |
| VL-0716175A | $17.00 | $17.08 | **+$0.08** | $0.08 |

Both differences equal the shipping-protection fee exactly, and both rows have
`shipping_protection_fee = 0.00`. These are the legacy rows `reconciliation-math.ts` describes — protection
folded into `amount_paid` before the column existed. Neither is a paid order (pending / failed), so no cash is
affected. The reconciliation screen's `maxShippingProtectionFee` allowance absorbs them correctly.

---

### FIN-12 — All business configuration lives in the audit-log table, surfaced through a `DISTINCT ON` view
**SYSTEM:** Configuration integrity · **SEVERITY:** MEDIUM · **CONFIRMED**

`admin_control_current` is not a table:

```sql
SELECT DISTINCT ON (target_table, target_id) …
FROM admin_audit_logs
WHERE action = 'admin_control_upsert' …
ORDER BY target_table, target_id, created_at DESC
```

Shipping fees, free-shipping thresholds, commission rates, coupon policy, tax nexus, and the entire profit
model are **audit-log rows**. There is no configuration table.

**BUSINESS IMPACT:** Any retention policy, pruning job, or redaction pass over `admin_audit_logs` (the repo
contains `admin-audit-redaction.ts`) silently reverts business configuration to code defaults — changing what
customers are charged for shipping, what ambassadors earn, and how profit is modelled, with no config record
to compare against and no alert. `admin_audit_logs` currently holds 907 rows.

This is also the mechanism behind FIN-03: a blank value saved into one of these rows disabled tax collection.

---

### FIN-13 — Three reporting surfaces use three different date bases for the same events
**SYSTEM:** Revenue / analytics / tax · **SEVERITY:** MEDIUM · **CONFIRMED**

| surface | date field | window |
|---|---|---|
| `admin-revenue.getRevenueMetrics` | `paid_at` only, `IS NOT NULL` required | UTC calendar day |
| `admin-analytics.revenueFromRows` | `paid_at ?? created_at` | server-local calendar day; 7/30-day are *rolling* |
| `admin-tax-report` | `created_at` | UTC calendar **year** |

**DIFFERENCE:** A paid order with a NULL `paid_at` counts in analytics (via `created_at`) and not in revenue.
`revenueFromRows` additionally skips any order where `amount <= 0`, while the revenue RPC counts it in
`count(*)` — so the two AOV denominators differ. "Today" is a calendar day while "last 7 days" is a rolling
168 hours, on the same tile.

---

### FIN-14 — Day and month boundaries are UTC for a US-Eastern business
**SYSTEM:** Reporting / commission tiers / tax filing · **SEVERITY:** MEDIUM · **CONFIRMED**

- `admin-revenue.ts`: `Date.UTC(y, m, d)` — "today's revenue" rolls over at **20:00 ET** (DST) / 19:00 ET.
- `admin-analytics.ts`: `date.setHours(0,0,0,0)` — server-local, which on Vercel *is* UTC. Same cliff,
  different code, so the two agree today only by deployment accident.
- `ambassador-commission.monthStartUtc()` — the monthly qualifying-sales count that drives commission tiers
  uses a UTC month boundary. Orders in the last 4–5 hours of a month ET fall into the next month's tier count.
- `admin-tax-report`: filters the **filing year** as `${year}-01-01T00:00:00Z`. Orders placed in the final
  hours of 31 December ET land in the following filing year.

The last one is the one that matters: a statutory report should not use a UTC year boundary for a Florida
filer.

---

### FIN-15 — 335 cart-recovery coupons exist; 333 of them belong to one email address
**SYSTEM:** Coupons · **SEVERITY:** MEDIUM · **CONFIRMED**

| assigned_email | coupons | first | last |
|---|---:|---|---|
| btunchi88@gmail.com | **333** | 2026-07-21 | 2026-08-03 |
| robinlagrama@gmail.com | 1 | 2026-07-27 | |
| brendenhuntzinger1@vantalabsresearch.com | 1 | 2026-08-04 | |

There are only **8** `abandoned_carts` and **27** `abandoned_cart_emails`. The recovery job minted 333
discrete 5%-off codes for a single address over 13 days — no per-cart or per-email dedup, no throttle.

All 335 are now expired and none was ever redeemed, so there is no realised loss. But 91% of the coupon table
is generator noise, and had the expiry window been longer the same address would hold 333 live discount codes.

---

### FIN-16 — Coupons have no minimum-order, no maximum-discount, no product scope, and no per-customer limit
**SYSTEM:** Coupons · **SEVERITY:** MEDIUM (structural) · **CONFIRMED**

The `coupons` table's full column set is: `code, discount_type, discount_value, starts_at, ends_at,
max_redemptions, redemptions_count, active, created_at, assigned_email, source, is_private, member_scope`.

There is **no** `min_order_amount`, **no** `max_discount_amount`, and **no** product restriction. The audit
brief's boundary tests (minimum − $0.01 / exactly minimum / + $0.01) are therefore not applicable: **no
minimum-order rule exists to test**. A 30% coupon on a $2,000 cart takes $600 off, uncapped.

**Verified correct:** the discount arithmetic itself. `calculateCouponDiscount`
(`coupons.ts:24-28`) computes `fixed ? value : subtotal × value/100`, then
`roundMoney(Math.min(Math.max(amount, 0), subtotal))` — clamped to the subtotal and rounded to the cent, so a
$25 fixed coupon on a $2.00 cart yields exactly $2.00 off and never a negative total. No coupon in the table
has a negative value or a percent above 100.

All 32 non-generated coupons are currently `active = false`, so nothing is redeemable today.

---

### FIN-17 — Two published products have no purchasable dose
**SYSTEM:** Catalog · **SEVERITY:** MEDIUM · **CONFIRMED**

| slug | `is_published` | `is_enabled` | enabled doses | dose stock | `stock_status` |
|---|---|---|---:|---:|---|
| `cerebrolysin` | true | **false** | **0** | 0 | Out of Stock |
| `pinealon` | true | **false** | **0** | 0 | **In Stock** |

Both are published with zero enabled doses. `pinealon` additionally advertises `stock_status = 'In Stock'`
while holding zero inventory and being disabled — three fields, three different answers.

Both also carry the un-updated placeholder cost (parent 3500 = dose 3500, the only two products where the
ratio is 1.00 — see FIN-01).

---

### FIN-18 — Five published products count the same physical units in both the parent row and the dose rows
**SYSTEM:** Inventory · **SEVERITY:** MEDIUM · **CONFIRMED**

| slug | parent qty | parent tracks | dose qty | doses |
|---|---:|---|---:|---|
| bacteriostatic-water | **38** | false | **39** | 10mL=39 |
| cagrilintide | 19 | true | 19 | 10mg=19 |
| hgh-gh-191 | **20** | true | **40** | 24iu=20, 36iu=20 |
| igf-1-lr3 | 19 | true | 19 | 1mg=19 |
| thymosin-alpha-1 | 19 | true | 19 | 5mg=19 |

The remaining 33 published products correctly hold `parent = 0` with stock at the dose.

- `bacteriostatic-water` — parent and dose **disagree by one unit**, and the parent has tracking off.
- `hgh-gh-191` — a single parent count of 20 against two doses of 20 each; the parent figure has no meaning.
- The other three are the same units recorded twice.

**Verified correct:** availability itself. `canonical-availability.sql:52-53` selects the **dose** row when
doses exist and the parent only otherwise, so the parent-zero/dose-stocked architecture the brief asked about
works — a stocked dose is **not** made unavailable by a zero parent. Nothing in the audited code sums parent
and dose together. The risk is that these five rows make such a sum look plausible.

---

### FIN-19 — Legacy bare-slug order lines reserved and decremented the parent row, not the dose
**SYSTEM:** Inventory · **SEVERITY:** MEDIUM (historical) · **CONFIRMED**

Five reservation rows carry `variant_id = NULL` (`glp-1`, `5-amino-1mq`, `bacteriostatic-water` ×2, `hcg` ×4),
so `reserve_inventory` / `finalize_inventory_for_order` took the `else` branch and moved
`products.inventory_quantity` — while the storefront reads the dose. This is the documented oversell path and
it is the most likely origin of the parent/dose disagreements in FIN-18. Current code rebuilds the id with
the resolved dose (`quote-order.ts`, "Carry the RESOLVED dose in the line id"), so new orders are correct.

---

### FIN-20 — Four reservation rows reference orders that do not exist
**SYSTEM:** Inventory / referential integrity · **SEVERITY:** LOW · **CONFIRMED**

`inventory_reservations` has **no foreign key to `orders`**. Four `hcg` rows
(`order-50f4f55e…`, `order-d7438487…`, `order-47ebb6a0…`, `order-98ec5610…`, 2026-07-31 → 08-01) have no
matching order row — holds were taken for orders that were never persisted. All four are `released`, so no
stock is affected now.

---

### FIN-21 — Stale `pending_payment` orders hold no stock and carry a non-zero `amount_paid` indefinitely
**SYSTEM:** Orders / inventory · **SEVERITY:** MEDIUM · **CONFIRMED**

Reservations expire after 15 minutes and are swept by `expire_stale_reservations`, but the order stays
`pending_payment` forever. Five such orders exist, the oldest from 2026-08-03:

| order | created | `amount_paid` carried | reservation |
|---|---|---:|---|
| VL-64F8EDE4 | 08-03 | $125.02 | released |
| VL-DCA0FAD5 | 08-09 | $68.49 | released |
| VL-B10D3E7A | 08-26 | $98.18 | released 20:00 |
| VL-DA402437 | 08-26 | $103.38 | released 20:00 |
| VL-AD39DBEF | 08-26 | $103.38 | released 20:00 |

If any of these is later paid, the stock it assumed is gone. Together they carry **$498.45** of `amount_paid`
that is not money.

**Verified correct:** the sweeper itself. I first read three doses showing `reserved_quantity` of 3/1/2 and
re-read after the sweep ran — all counters returned to zero and `expire_stale_reservations` decrements the
counter *before* marking the row released. There are **no** stranded reservation counters.

---

### FIN-22 — Test-priced orders are inside production revenue and AOV
**SYSTEM:** Metrics hygiene · **SEVERITY:** MEDIUM · **CONFIRMED**

Four **paid** production orders were priced far below catalogue:

| order | item | unit price charged | catalogue price | status |
|---|---|---:|---:|---|
| VL-49CA32C1 | Monthly Membership — Vanta Essential | **$1.00** | $9.99 | paid |
| VL-8D132452 | Bac Water 10mL ×2 | **$1.90** | $14.99 | paid |
| VL-37C1E4B0 | Bac Water 10mL ×1 | **$2.00** | $14.99 | paid |
| VL-0716175A / VL-9D8CA974 | Bac Water | $2.00 / $1.90 | $14.99 | failed |

These are 4 of the 6 paid orders. They pull AOV from **$46.28** (excluding them, product orders only) down to
**$38.73**, and every profit and margin figure on the dashboard is dominated by them.

Related: `store_credit_ledger` contains a row with `reason = 'test_grant'`, `amount_cents = 3000` — a
**$30.00 spendable store credit** created in production on 2026-07-21 for user `46beeab4…`.

*Note:* the server is the sole price authority (see §2), so these are not a client-price bypass — they reflect
catalogue prices as they stood, or an admin price change during testing. Either way they are test data inside
live financial metrics.

---

### FIN-23 — One order has a NULL `order_number`
**SYSTEM:** Order ledger · **SEVERITY:** LOW · **CONFIRMED**

`order-64d083fa-f17a-4793-a960-427ec58263c0` (2026-08-03): `order_number` NULL, `subtotal` $0.00,
`amount_paid` $0.00, **zero** `order_items`, `payment_status` canceled, and a `provider_event_id` in a
different format from every other row (`evt_xckDtz8iHQjoHmoeU5qtHYjg` vs `vtxn_…`). The partial unique index
`idx_orders_order_number … WHERE (order_number IS NOT NULL)` permits this. It is the only order that would
appear as a blank row in an export.

---

### FIN-24 — Bundle savings are baked into `unit_price` and never appear in `discount_amount`
**SYSTEM:** Discount reporting · **SEVERITY:** MEDIUM · **CONFIRMED**

VL-EA5529EF: Bac Water ×2 at `unit_price = 14.24` against a catalogue price of $14.99 — the 2-unit
"Bundle & Save" 5% tier ($14.99 × 0.95 = $14.2405 → $14.24, exact). The order's `discount_amount` is
**$0.00**.

`getBundleDiscountedUnitPrice` is applied to the unit price inside `quoteOrder` before the subtotal is formed,
so quantity-bundle savings are structurally invisible to `orders.discount_amount`.

**BUSINESS IMPACT:** Any "total discounts given" report built on `discount_amount` omits every bundle
discount. Order totals and tax are unaffected (`subtotal` is already net), so this is a reporting completeness
gap, not a pricing error.

---

### FIN-25 — Both live memberships sit on a deactivated tier, and one contradicts its own cancellation
**SYSTEM:** Memberships · **SEVERITY:** MEDIUM · **CONFIRMED**

Both `customer_memberships` rows point at tier `essential`, which has `is_active = false` (deactivated
2026-08-09).

`getMembershipPerks` (`membership.ts:188-210`) joins `membership_tiers(*)` by `tier_id` and **does not filter
on `is_active`**, while `getTiers()` (`membership.ts:96`) does. So a retired tier is hidden from the pricing
page but still grants its 5% discount, $5/month credit and $200 free-shipping threshold. Grandfathering may
well be intended — but it is nowhere stated, and the storefront and the entitlement engine disagree about
which tiers exist.

**The contradiction:** user `537a8605…` has `status = 'active'` and `cancelled_at = NULL`, yet
`membership_billing_events` records a **succeeded `cancellation`** for that user at `2026-08-04T00:46:05`, and
`cancel_at_period_end = true`. The membership row and the billing ledger disagree about whether this person is
a member. `isMembershipActive` reads only `status`, so they are currently treated as fully active.

---

### FIN-26 — Every tier, including Vanta Black, has a $1.00 seven-day intro offer enabled
**SYSTEM:** Membership economics · **SEVERITY:** HIGH (risk) · **CONFIRMED**

`intro_price_cents = 100` and `intro_offer_enabled = true` on **all five** tiers:

| tier | monthly | annual | monthly store credit | member discount | intro |
|---|---:|---:|---:|---:|---:|
| free | $0 | $0 | $0 | 0% | **$1.00 / 7d** |
| essential *(inactive)* | $9.99 | $99.90 | $5.00 | 5% | $1.00 / 7d |
| pro | $24.99 | $249.90 | $15.00 | 8% | $1.00 / 7d |
| elite | $39.99 | $399.90 | $30.00 | 10% | $1.00 / 7d |
| **black** | **$89.99** | $899.90 | **$75.00** | 12% | **$1.00 / 7d** |

`$75.00` of monthly store credit is granted against a `$1.00` intro charge on Vanta Black. Store credit is
spendable money (`store_credit_min_order_cents = 25000`, so a $250 order redeems it). The `free` tier having a
$1.00 intro price on a $0 product is a straightforward contradiction.

Whether the monthly grant actually fires during the intro window was **not** verified in this lane — the grant
runs through `reconcileMonthlyStoreCredit` on the billing path and no intro membership exists in production to
observe. Flagged as a configuration risk requiring a deliberate check, not as a realised loss.

---

### FIN-27 — A $1.00 intro price has become a recurring billing amount
**SYSTEM:** Membership billing · **SEVERITY:** MEDIUM · **CONFIRMED**

User `75b38d2a…`, tier `essential` ($9.99/month):

```
status                    = paused
intro_status              = not_applicable      ← no intro is running
intro_started_at          = null
intro_ends_at             = null
next_billing_amount_cents = 100                 ← $1.00
next_billing_at           = 2026-10-03
```

`intro_status = 'not_applicable'` with a $1.00 next-billing amount is internally contradictory: the intro
price is scheduled as the ongoing price. If this membership resumes it bills **$1.00 against a $9.99 plan**.
Order VL-49CA32C1 ($1.00 membership, paid) is the corresponding charge.

---

### FIN-28 — A commission tier can silently *undercut* an ambassador's configured rate
**SYSTEM:** Commissions · **SEVERITY:** MEDIUM (latent) · **CONFIRMED in code**

`getEffectiveCommissionPercent` (`ambassador-commission.ts:186-198`) states its intent:

> *"Starting from null and only assigning on a genuine qualification keeps the tier design intact … while
> making the configured rate the **floor** rather than something a tier can quietly undercut."*

The implementation delivers that only when **no** tier matches. Once any tier matches it returns
`matched.commissionPercent` outright:

```js
let matched = null;
for (const tier of tiers) if (monthlySales >= tier.minMonthlySales) matched = tier;
if (!matched) return { percent: ambassadorPercent, tierName: null };
return { percent: matched.commissionPercent, tierName: matched.name };   // ← replaces, never floors
```

Active tiers are Starter 10% @ 10 sales, Growth 12.5% @ 25, Elite 15% @ 50. An **unlocked** ambassador
configured at 20% who reaches 10 monthly sales is cut to **10%** — penalised for selling more.

**Currently latent:** 7 of 8 ambassadors have `commission_percent_locked = true` (the lock short-circuits
before the tier logic). The only unlocked one, ELIJAH-AB78AE, is at 10% and has status `info_requested`, so
earns nothing. Also masked at checkout, where the profit guard uses
`Math.max(referral.commissionPercent, effective.percent)` — the guard is conservative, but the **accrual**
uses `effective.percent` alone, so the guard's max does not protect the amount actually paid.

---

### FIN-29 — The mirrored commission tables have opposite delete semantics
**SYSTEM:** Referential integrity · **SEVERITY:** MEDIUM · **CONFIRMED**

```
referral_orders.ambassador_id → ambassadors(id)  ON DELETE RESTRICT
commissions.partner_id        → partners(id)     ON DELETE CASCADE
payouts.partner_id            → partners(id)     ON DELETE CASCADE
```

`ambassadors` and `partners` are a deliberate 1:1 mirror sharing primary keys (verified: all 8 pairs match on
id, code, `commission_percent`, `customer_discount_percent` and `status`). Deleting the `partners` row
**cascades away the commission and payout ledger**, while the `ambassadors` side would have refused the same
delete. One half of a mirrored identity protects the financial record and the other half destroys it.

---

### FIN-30 — Four approved ambassadors have no explicit customer discount; combined giveaway reaches 30%
**SYSTEM:** Affiliate configuration · **SEVERITY:** MEDIUM · **CONFIRMED**

| code | commission | `customer_discount_percent` | effective customer discount | combined |
|---|---:|---|---:|---:|
| 1ANGEL | 15% | 15.00 | 15% | 30% |
| MIZZY | 15% | 15.00 | 15% | 30% |
| SMOKE | 15% | 15.00 | 15% | 30% |
| **ZAIN** | **20%** | **NULL** | 10% *(program default)* | **30%** |
| ELOA | 15% | **NULL** | 10% | 25% |
| FLAVIAROSSETTI | 15% | **NULL** | 10% | 25% |
| BRUTUS | 10% | **NULL** | 10% | 20% |
| ELIJAH-AB78AE | 10% | 10.00 | 10% | *(not approved)* |

`resolveAmbassadorCustomerDiscount(null, 10)` supplies the program default, so the NULLs are handled — but
four approved ambassadors' customer discount is implicit and moves if
`referral.discount_percent` is ever edited.

**Verified correct — and this is the question the brief flagged as high priority:** the system does
distinguish customer discount from commission. They are separate columns, separate control keys
(`referral.discount_percent` vs `referral.default_commission_percent`), separate defaults (10% / 20%
personal / 10% commission), and `ensureCommissionRecord` snapshots both onto the row independently. ZAIN
(20% commission, 10% customer discount) proves the two are genuinely decoupled.

**The commission base is unambiguous and consistent in all three places it is computed:**
`commissionAmount = commissionableSubtotal × commissionPercent / 100`, where `commissionableSubtotal` is
merchandise **after discount, before shipping, before tax** — `payment-webhook.ts:721`,
`profit-engine.ts:244`, and the checkout guard all agree.

**BUSINESS IMPACT:** At 30% combined, against the $100 minimum qualifying order: $100 merchandise → customer
pays $90, ambassador earns $20 (20% of $90 = $18 for ZAIN), leaving $72 before COGS, an 8% processor fee on
the total, and shipping. Viable on high-margin SKUs (dose costs are 4–15% of price); thin on `cerebrolysin` /
`pinealon`, whose recorded cost is $35.00 against $73–75 prices. The checkout profit guard exists but its
floors are `min_profit_dollars = 0` and `min_profit_percent = 0`, so it only blocks outright losses.

---

### FIN-31 — Money and stock columns have no non-negative constraints
**SYSTEM:** Schema invariants · **SEVERITY:** MEDIUM · **CONFIRMED (deliberately held)**

`src/lib/sql/add-money-stock-check-constraints.sql` defines 20 `CHECK (col >= 0)` constraints across
`orders`, `referral_orders`, `commissions`, `payouts`, `coupons`, `products` and `product_doses`. The file is
headed **"SAFE MIGRATION, HELD FOR REVIEW — do NOT run until check #5 … returns all zeros."**

**None of the 20 exist in production.** The only non-negative checks deployed are
`orders_shipping_protection_fee_nonneg`, `order_items_unit_cost_cents_nonneg`,
`products_incoming_quantity_nonneg` and `product_doses_incoming_quantity_nonneg`.

So `orders.amount_paid`, `subtotal`, `discount_amount`, `refund_amount`, `tax_amount`, `shipping_amount`, and
`products/product_doses.price_cents`, `inventory_quantity`, `product_cost_cents` can all go negative at the
database level.

**The precondition for applying them is met.** I ran the equivalent of check #5 and it returns all zeros —
see §3.

---

### FIN-32 — `promotions.free_shipping_threshold` is an admin-editable control that nothing reads
**SYSTEM:** Configuration · **SEVERITY:** LOW · **CONFIRMED**

Two free-shipping threshold keys exist: `shipping.free_shipping_threshold` = `200` (read by
`getShippingConfig`, `admin-control.ts:720`) and `promotions.free_shipping_threshold` = `""` (written by the
admin UI, **read by nothing**). An admin editing the threshold in the Promotions section changes nothing.

---

### FIN-33 — Store-credit grants are wrapped in an empty catch
**SYSTEM:** Store credit · **SEVERITY:** MEDIUM · **CONFIRMED**

`membership-billing.ts:625`:

```js
await reconcileMonthlyStoreCredit(input.userId, tier.monthly_store_credit_cents ?? 0).catch(() => {});
```

Store credit is spendable money. A failure here is not logged, not alerted, and not retried — the member
silently loses their monthly grant. (`membership-billing.ts:1211/1231` use the same pattern, but around a
`recordSystemAlert` and a `recordBillingEvent`, which is defensible.)

---

### FIN-34 — `finalize_inventory_for_order` consumes the reservation even when no inventory row moved
**SYSTEM:** Inventory · **SEVERITY:** LOW · **CONFIRMED in code**

```sql
update public.product_doses set inventory_quantity = greatest(0, inventory_quantity - r.quantity) …
  where id::text = r.variant_id;
get diagnostics line_moved = row_count;
…
update public.inventory_reservations set status = 'finalized' … where id = r.id;   -- unconditional
if line_moved > 0 then n := n + 1; end if;
```

If the dose was deleted or renamed, `line_moved = 0`, no stock is decremented, but the reservation is still
marked `finalized` and the loop continues. The `greatest(0, …)` clamp likewise absorbs an over-decrement
silently. The caller sees a lower return count; nothing raises.

---

### FIN-35 — An order item names a dose that does not exist
**SYSTEM:** Catalog / order data · **SEVERITY:** LOW · **CONFIRMED**

VL-64F8EDE4's line reads `5-Amino-1MQ (5mg)`. The only dose `5-amino-1mq` has ever had is **50mg**. The
product name string was captured with a dose label that has no counterpart in `product_doses`. The line also
carries the bare slug (no `::doseId`) and the placeholder cost — same root cause as FIN-02.

---

## 2. THINGS I VERIFIED AND FOUND CORRECT

These were checked with the same rigour as the findings and reconcile exactly. They are recorded so the other
lanes do not re-litigate them.

| Check | Result |
|---|---|
| `order_items.line_total = unit_price × quantity` | **0 mismatches** across 20 rows |
| `orders.subtotal = SUM(order_items.line_total)` | **0 mismatches** across every order with items |
| Paid orders with no line items | **0** |
| Negative money on `orders` | **0** |
| Negative stock / price / cost on `products`, `product_doses` | **0** |
| `refund_amount > amount_paid` | **0** |
| Coupons with negative value, or percent > 100 | **0** |
| Dose priced below its own recorded cost | **0** |
| Order component sum vs `amount_paid` | **16 of 18 exact to the cent** (2 legacy — FIN-11) |
| `payment_events` vs paid orders | **6 paid events, 6 paid orders, 1:1** |
| Analytics `purchase` events | **6 events, 6 distinct sessions** — no double counting |
| Duplicate captured payments | **none.** Partial unique indexes exist on `payment_id`, `provider_event_id`, `idempotency_key`, `order_number`, `shippo_order_id` |
| Near-duplicate order pairs (3 found) | all retries — at most one paid per pair, distinct idempotency keys, **no double charge** |
| Reservation counters after expiry sweep | **all zero**; `expire_stale_reservations` decrements before marking released |
| **Price authority** | Server-side only. `quoteOrder` accepts `{id, quantity}` and re-prices from the catalogue; `parseProductPrice` fails closed on `<= 0`. `expectedTotal` from the client rejects **underpayment only**. No client-supplied price can become authoritative. |
| Membership profit treatment | Correct — `admin-profit.ts:132-141` gives memberships `shippingCost = 0`, `lines = []`, and `shippingCostIsEstimate = false`. My own independent model got this **wrong** and the application was right. |
| Commission base consistency | `commissionableSubtotal × percent` — identical in the checkout guard, the accrual, and the profit engine |
| Ambassador ↔ partner mirror | all 8 pairs agree on id, code, rate, discount and status |
| Coupon discount arithmetic | clamped `[0, subtotal]`, rounded to cents |
| Dose availability with zero parent stock | Correct — `canonical-availability.sql` prefers the dose row; a stocked dose is not hidden by a zero parent |
| Replacement handling in code | `NON_SALE_ORDER_TYPES` correctly excludes replacements from TS revenue and AOV, and `order-profit` keeps their cost (see caveat below) |

---

## 3. INDEPENDENT PROFIT RECONCILIATION

Computed in SQL from raw columns — not by calling `computeOrderProfit`. Model:
`(subtotal − discount) + shipping + protection + tax` (tax counted, per `count_sales_tax_as_profit = true`)
`− COGS(snapshot) − shipping expense − processor fee − commission − refund`.
Shipping expense $6.00 (config default, FIN-04); processor fee 8% of `amount_paid` (FIN-08); commission $0.

| order | gross rev | = `amount_paid`? | COGS | ship exp | proc fee | **profit** |
|---|---:|---|---:|---:|---:|---:|
| VL-E8F4D52F | 76.04 | ✓ | 24.56 | 6.00 | 6.08 | **39.40** |
| VL-49CA32C1 *(membership)* | 1.00 | ✓ | 0 | 0 | 0.08 | **0.92** |
| VL-8847B157 | 73.84 | ✓ | 25.20 | 6.00 | 5.91 | **36.73** |
| VL-EA5529EF | 45.47 | ✓ | 16.00 | 6.00 | 3.64 | **19.83** |
| VL-8D132452 | 18.95 | ✓ | 2.86 | 6.00 | 1.52 | **8.57** |
| VL-37C1E4B0 | 17.08 | ✓ | 1.43 | 6.00 | 1.37 | **8.28** |
| **TOTAL** | **232.38** | ✓ | **70.05** | **30.00** | **18.60** | **113.73** |

**Independently derived gross revenue equals `amount_paid` on every single order.** The revenue side of the
ledger is sound.

The expense side is not:
- **COGS $70.05 contains $51.39 of placeholder cost** (FIN-02). At true dose costs, COGS is $18.66 and profit
  is **$165.12**, not $113.73 — a **45%** understatement.
- **Shipping expense $30.00 is entirely modelled.** Real postage on the two labelled orders is unknown
  (FIN-04).
- **Processor fee $18.60 is entirely modelled** at an unverified 8% (FIN-08).
- **$9.69 of that profit is collected sales tax owed to Florida** (FIN-10).

So of $113.73 reported profit, **$48.60 (43%) is modelled rather than observed**, and the observed part is
wrong by $51.39 in the conservative direction.

---

## 4. FINAL ANSWERS

**ARE PRODUCT PRICES CORRECT?** — **Yes, with two exceptions.** The server is the sole price authority; no
client-supplied price can become authoritative; catalogue → dose → order-item prices agree; `parseProductPrice`
refuses $0. Exceptions: two published products have no purchasable dose (FIN-17), and four paid production
orders were priced at $1.00–$2.00 test values (FIN-22).

**IS INVENTORY INTERNALLY CONSISTENT?** — **Mostly.** No negative or impossible stock; availability correctly
prefers the dose row; reservations reserve, finalize and expire correctly. But five products count the same
units in both parent and dose rows, one disagreeing by a unit (FIN-18), legacy bare-slug lines moved parent
stock (FIN-19), and four reservations reference orders that never existed (FIN-20).

**ARE COUPONS MATHEMATICALLY CORRECT?** — **The arithmetic is correct** (clamped, rounded, no negatives, no
percent > 100). **The rule set is incomplete**: no minimum-order, no maximum-discount, no product scope
(FIN-16). And 91% of the table is generator noise from one email (FIN-15).

**IS AFFILIATE ATTRIBUTION CONFIGURATION CORRECT?** — **Yes.** Customer discount and ambassador commission are
genuinely separate quantities with separate columns, controls and defaults. Four approved ambassadors rely on
the implicit program default for the customer discount (FIN-30).

**ARE AFFILIATE COMMISSIONS MATHEMATICALLY CORRECT?** — **Cannot be reconciled against data: zero commissions
exist.** The formula is correct and consistent in all three implementations. Two defects are latent: a tier
can undercut a configured rate (FIN-28), and the commission ledger cascades away on a partner delete (FIN-29).

**DO AFFILIATE TOTALS RECONCILE?** — **Trivially: all totals are zero** across `referral_orders`,
`commissions`, `payouts` and every dashboard. The reason they are zero is FIN-07 — a NOT-NULL violation
swallowed as `console.error` on every accrual.

**DO ORDERS RECONCILE TO THEIR ITEMS?** — **Yes. Zero mismatches**, both line-level and order-level.

**DO PAYMENT AMOUNTS RECONCILE TO ORDERS?** — **Yes for all six paid orders**; independently derived totals
equal `amount_paid` exactly. Two non-paid legacy rows sit $4.08 above their components (FIN-11).

**IS SHIPPING REVENUE/EXPENSE ACCOUNTED FOR CORRECTLY?** — **No.** Revenue yes ($15.00 flat under a $200
threshold, correctly applied). **Expense is never recorded** — two real Shippo labels, zero postage captured,
and a $6.00 flat model standing in (FIN-04).

**IS COGS COMPLETE AND CORRECT?** — **Complete, not correct.** Every product line has a cost snapshot. But
four orders carry a placeholder 3–6.8× too high (FIN-02), and the fallback that produced them is still live
for any unresolved dose (FIN-01).

**ARE PROCESSOR FEES ACCOUNTED FOR?** — **Modelled, never settled.** 8% of the tax-inclusive total, from a
blank config falling through to a code default. Nothing ingests a real fee (FIN-08). The code labels it as an
estimate everywhere, which is to its credit.

**IS REVENUE DEFINED CONSISTENTLY?** — **In TypeScript, yes** — `ledger.ts` is a genuine single source of
truth and every TS surface reaches it. **In the database, no** — the deployed rollups run an older definition
(FIN-05), and three surfaces use three date bases (FIN-13).

**IS AOV CORRECT?** — **Arithmetically yes** ($232.38 ÷ 6 = $38.73). **Meaningfully no** — four of the six
orders are test-priced (FIN-22), and the deployed RPC would admit replacement $0 denominators the moment one
exists (FIN-05).

**ARE REPLACEMENTS TREATED CORRECTLY?** — **In application code, yes.** No replacement order exists, so this
is a code review, not a reconciliation: `NON_SALE_ORDER_TYPES` excludes them from revenue and AOV while
`order-profit` retains their cost. **In the database, no** — no deployed rollup excludes them (FIN-05).

**ARE MEMBERSHIP ECONOMICS CORRECT?** — **No.** Profit treatment is correct (no COGS, no shipping cost). But
both live memberships sit on a deactivated tier still granting benefits (FIN-25), one contradicts its own
cancellation event (FIN-25), one has a $1.00 intro price as its recurring amount (FIN-27), and every tier —
including $89.99/month Vanta Black with $75/month store credit — carries a $1.00 seven-day intro (FIN-26).

**IS PROFIT MATHEMATICALLY CORRECT?** — **The engine is correct; its inputs are not.** `computeOrderProfit` is
a clean, single, well-documented implementation and I found no arithmetic error in it. But 43% of reported
profit is modelled rather than observed, COGS is overstated by $51.39, and $9.69 of tax owed to Florida is
counted as earnings.

**DO ADMIN FINANCIAL NUMBERS AGREE WITH DATABASE TRUTH?** — **Revenue yes, today.** Both definitions return
$232.38 / 6 / $38.73. Profit no (inputs above). And the agreement on revenue is coincidental — it holds only
because no replacement or partially-refunded order exists yet.

**ARE THERE ANY SILENT FINANCIAL FAILURES?** — **Yes, and they are the most serious finding in this audit.**
Ten financial operations in the paid-order pipeline are caught, logged to a serverless console, and continued
past, behind a claim token that is spent before they run so nothing retries (FIN-07). The empty commission
ledger is that failure mode already realised in production. Plus an empty catch around store-credit grants
(FIN-33).

**ARE THERE ANY DATA STATES THAT SHOULD BE IMPOSSIBLE?** — **Yes, seven:** a published product with zero
purchasable doses (×2); `pinealon` "In Stock" with zero inventory while disabled; an order with a NULL
`order_number`, $0 total and no items; reservations for orders that do not exist (×4); a membership `active`
with a succeeded cancellation event; `intro_status = 'not_applicable'` with a $1.00 next-billing amount; a
$1.00 intro price on a $0.00 free tier. None is blocked by a constraint, because the money/stock constraint
migration is held unapplied (FIN-31).

---

## 5. WHAT REMAINS NOT VERIFIED

Stated plainly so no one mistakes silence for assurance.

1. **True postage cost.** No actual carrier charge exists in the database. Whether $6.00 is high or low is
   unknown; it needs a Shippo statement.
2. **The real processor rate.** 8% could not be validated against any settlement artefact.
3. **Historical tax nexus.** No `tax` control row predates 2026-08-23, so why Idaho was taxed on 2026-08-03
   cannot be recovered from data.
4. **Whether the $1.00 intro actually grants monthly store credit.** No intro membership exists to observe,
   and I did not create one (read-only lane). FIN-26 is a configuration risk, not a measured loss.
5. **Commission behaviour end to end.** Zero commissions exist. The formula was read, not exercised. Refund
   reversal, payout, hold-days and tier escalation are all unexercised against real data.
6. **Replacement economics against real data.** Zero replacement orders exist.
7. **Points earn/redeem on orders.** `points_ledger` holds only 15 signup bonuses; every order has
   `points_earned = 0` and `points_redeemed = 0`. Never exercised.
8. **Store credit redemption at checkout.** Never exercised — `store_credit_redeemed_cents = 0` on all 18
   orders. `admin-profit.ts:120-130` explicitly notes the accounting policy for a redeeming order "has never
   been stated" in this codebase.
9. **Whether `payment_processor.enabled = false` (with `provider = "live"`, blank publishable key) is
   consistent with card orders processing.** Noted, not chased — it belongs to the transactional lane.
10. **RLS and RPC grant posture.** Deliberately left to the other lanes.
11. **Anything requiring a write.** No transaction, order, coupon redemption or membership was created.

---

## 6. FINANCIAL / DATA VERDICT

# 🔴 NOT RECONCILED

The **revenue** side of this ledger is sound and I can say so with evidence: every paid order's total is
independently derivable from its own components, orders reconcile exactly to their items, payments reconcile
1:1 to orders, there are no duplicate charges, no negative money, and the server is the unambiguous price
authority. A great deal of careful engineering is visible in this codebase and most of it holds up.

The verdict is red because of the **expense and integrity** sides:

1. **COGS is wrong on 45% of recorded profit** by a placeholder cost that is still the live fallback (FIN-01,
   FIN-02).
2. **Shipping expense — real cash paid to a carrier — is not recorded at all**, on every order that has
   shipped (FIN-04).
3. **Sales tax collection is switched off in the store's own home state**, on live paid orders (FIN-03).
4. **Ten financial operations fail silently and never retry**, and the empty commission ledger proves this has
   already happened in production (FIN-07).
5. **The deployed revenue functions are not the ones the tests verify** (FIN-05, FIN-06) — so "verified"
   currently means "verified against a file", and the next reconciliation defect will hide in the same place.

Points 1, 2 and 4 mean the store does not currently know what it earns. Point 3 is a compliance exposure that
grows with every Florida order. Point 5 means the reporting layer cannot yet be trusted to detect its own
drift.

None of these is unfixable, and none is architectural — but a green verdict would require the numbers to be
right, and today three of the five inputs to profit are either placeholders or absent.

---

*Read-only audit. No production code, data, schema or configuration was modified. No records were created.*
