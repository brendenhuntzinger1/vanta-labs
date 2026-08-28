# Block F — production changes required

**Nothing in this file has been applied.** No migration was run, no row was
updated, no production read was performed. This is the list to approve.

The code on `claude/block-ab-audit-o62bop` is correct on a database where these
have been applied. Until then, see **What happens if you deploy without these**
at the end.

---

## 1. Migration — `src/lib/sql/admin-dashboard-rollups.sql`

Re-run the whole file. It is `create or replace` throughout and safe to run more
than once. Four functions change.

### `admin_revenue_summary` and `admin_revenue_by_method`

```diff
- where payment_status in ('paid', 'completed', 'succeeded')
+ where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
```

**Why.** Your decision: a $200 order refunded by $50 is $150 of revenue. The
retained revenue on a partly refunded order used to vanish from the revenue page
entirely while `admin-profit` counted it — two numbers for one store. Net
revenue per order was already `max(0, amount_paid − refund_amount)`, so the $50
was already being handled correctly; the order was simply excluded.

**Effect on your numbers.** Revenue and order count go **up** by the retained
value of every partly refunded order. On 15 production orders this is likely
zero — check with query (a) below.

### `admin_customer_rollup`

```diff
- then coalesce(amount_paid, 0)
+ then round(greatest(0, coalesce(amount_paid, 0) - coalesce(refund_amount, 0)), 2)
```

**Why.** `total_spent` summed **gross** `amount_paid`, so a customer whose order
was fully refunded still showed as having spent the whole amount.

**Effect.** Customer lifetime values go **down** by whatever has been refunded.

### `admin_ops_summary`

```diff
- (select sum(coalesce(amount_paid, 0)) ... where payment_status = 'paid' ...)
+ (select sum(round(greatest(0, coalesce(amount_paid,0) - coalesce(refund_amount,0)), 2)) ...
+    where payment_status in ('paid','completed','succeeded','partially_refunded') ...)
```

**Why.** Live sales summed gross `amount_paid` for `status = 'paid'` only — both
ignoring refunds and dropping partly refunded orders.

**Effect.** Live sales today/this month move to net. Down by refunds, up by
retained partial-refund revenue.

---

## 2. One control setting — sales tax as profit

**This is the one that decides whether your profit numbers actually change.**

The code default for `count_sales_tax_as_profit` is now `false`
(`admin-control.ts`). **That default is only consulted when the key is absent.**
The Control Center writes this key on every save of its Profit section
(`admin-control-center-client.tsx:350`), and its client-side default is `true` —
so if that page has ever been saved, the control store holds `true` and the code
change does nothing at all.

**Two ways to apply it, your choice:**

- **Through the UI (no SQL, recommended):** Control Center → Profit Protection →
  turn *Count sales tax as profit* **off** → Save.
- **By SQL:** there is nothing to UPDATE. The control store is append-only —
  every save INSERTs a row into `admin_audit_logs` with
  `action = 'admin_control_upsert'`, and the `admin_control_current` view
  resolves the newest row per key. Changing the value means appending a new
  one, which is exactly what the Control Center does. Use query (c) below to
  read the value in force; make the change through the UI.

**Effect.** Every profit figure drops by the sales tax on every order —
dashboard, 30-day tile, per-order profit panel, CSV export. That is the point:
that money was never yours. It is still reported, as
`ProfitDashboard.salesTaxCollected`, a liability line.

---

## 3. Read-only queries to run FIRST

Run these before approving anything. They only read.

**(a) How much does the partial-refund decision actually move?**

```sql
select count(*)                                                  as partly_refunded_orders,
       round(sum(amount_paid - refund_amount), 2)                as retained_revenue_to_be_added,
       round(sum(refund_amount), 2)                              as refunded
from public.orders
where payment_status = 'partially_refunded';
```

**(b) How much do the customer/ops rollups move?**

```sql
select round(sum(refund_amount), 2) as total_refunds_currently_counted_as_spend
from public.orders
where payment_status in ('paid', 'partially_refunded', 'refunded')
  and coalesce(refund_amount, 0) > 0;
```

**(c) What is the sales-tax setting actually set to right now?**

```sql
select target_table as section,
       target_id    as key,
       metadata->>'value' as value,
       created_at
from public.admin_control_current
where target_table = 'profit'
order by target_id;
```

If no `count_sales_tax_as_profit` row comes back, the code default now applies
and nothing further is needed. If it comes back `true`, it must be changed.

**(d) How much profit is currently sales tax?**

```sql
select round(sum(tax_amount), 2) as tax_currently_counted_as_profit
from public.orders
where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
  and coalesce(tax_amount, 0) > 0;
```

That figure is how much reported lifetime profit will fall.

---

## 4. No historical data is rewritten

Worth stating plainly, since it was the condition you set:

- **No `UPDATE` to any order.** Every change above is to how orders are *read*.
- **No backfill.** Nothing recomputes a stored figure.
- **The one row that changes is a setting**, not a record — the control store
  (`admin_audit_logs`, `action = 'admin_control_upsert'`, surfaced by the
  `admin_control_current` view), section `profit`, key
  `count_sales_tax_as_profit`. It is reversible by flipping it back, which
  appends another row rather than overwriting this one.
- `orders.shipping_profit_cents` remains `NULL` on manually-corrected orders
  (finding F-14). Fixing that *would* need a data change and is deliberately
  **not** proposed here.

---

## What happens if you deploy the code without the migration

The revenue page has two paths: the RPC, and a JS fallback for a database where
the migration has not run. **They would disagree** — the fallback would count
partly refunded orders while the deployed RPC would not.

That is the exact defect F-03 fixed, so it is worth avoiding: **run the
migration with the deploy, not after it.**

Two guards exist against it drifting again:

- `ledger-sql-parity.test.ts` fails if the TypeScript definition of revenue and
  the SQL one stop agreeing, so neither can be changed alone.
- `financial-reporting-consistency.test.ts` loads the shipped SQL from the
  migration file and asserts both paths return the same number.

Neither can detect a *deployed* database whose functions are older than the
file. Only running the migration does that.
