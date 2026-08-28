import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PAID_ORDER_STATUSES, REVENUE_ORDER_STATUSES, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// BLOCK F — the TypeScript definition of "revenue" and the SQL one, kept in step.
//
// `getRevenueMetrics` has two paths that must produce the same number: an RPC
// that aggregates in Postgres, and a JS fallback for a database where that
// migration has not been run. They filter on the same set of payment statuses
// — one written in TypeScript, one written in SQL, in different files, neither
// able to import the other.
//
// That is exactly how the two got out of step before: the revenue page excluded
// partially refunded orders while the profit dashboard counted them, and the
// difference was invisible because nothing compared the definitions.
//
// So this compares them, textually. It cannot execute the SQL, and it does not
// try — it asserts that every status the ledger calls revenue appears in each
// function's WHERE clause, and that no OTHER status has been added to the SQL
// without being added to the ledger. Changing one side alone fails here.
// ---------------------------------------------------------------------------

const SQL_DIR = path.resolve(__dirname, "sql");
const SQL_PATH = path.resolve(SQL_DIR, "admin-dashboard-rollups.sql");
const sql = readFileSync(SQL_PATH, "utf8");

/**
 * ONE FILE IS NOT THE SURFACE.
 *
 * The gross-revenue assertion below used to read only admin-dashboard-rollups.
 * That is the file where revenue was CORRECTED, so scanning it alone proved
 * nothing about the copies that had not been: harness-prod-parity-functions.sql
 * carried a second, competing definition of `admin_ops_summary` whose body
 * summed gross `amount_paid` for payment_status='paid' only, and
 * setup-local-harness.sh applied it LAST — so the mandated verification harness
 * ran the wrong definition while this test stayed green.
 *
 * The check now runs over every .sql file in the directory. Adding a new
 * migration that sums gross revenue fails here without anyone remembering to
 * list it.
 */
const NOT_A_SHIPPED_DEFINITION = new Set([
  // One-off, read-only verification scripts. They report on live rows for a
  // specific investigation and define nothing the app calls; their gross sums
  // are deliberate ("what was actually collected"), not a revenue definition.
  "ambassador-e2e-verify.sql",
  "elijah-live-order-verify.sql",
]);

/** Strip SQL comments so prose ABOUT a defect is not mistaken for the defect. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function shippedSqlFiles(): Array<{ name: string; source: string }> {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql") && !NOT_A_SHIPPED_DEFINITION.has(name))
    .sort()
    .map((name) => ({ name, source: stripComments(readFileSync(path.join(SQL_DIR, name), "utf8")) }));
}

/**
 * Every `sum( ... )` expression in the source, matched by BALANCED PARENS.
 *
 * A regex cannot do this. `sum(...[^)]*)` stops at the first `)`, so any nested
 * call hides the rest of the expression from it — which is exactly how the
 * gross-sum assertion below came to inspect nothing at all.
 */
function sumExpressions(source: string): string[] {
  const found: string[] = [];
  const lowered = source.toLowerCase();
  for (let i = lowered.indexOf("sum("); i >= 0; i = lowered.indexOf("sum(", i + 1)) {
    // Skip an identifier that merely ENDS in "sum", e.g. checksum(.
    if (i > 0 && /[a-z0-9_]/.test(lowered[i - 1])) continue;
    let depth = 0;
    for (let j = i + 3; j < source.length; j += 1) {
      if (source[j] === "(") depth += 1;
      else if (source[j] === ")") {
        depth -= 1;
        if (depth === 0) { found.push(source.slice(i, j + 1)); break; }
      }
    }
  }
  return found;
}

/** Every `payment_status in (...)` list in the file, as sets of statuses. */
function statusFilters(source: string): string[][] {
  const filters: string[][] = [];
  const re = /payment_status\s+in\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    filters.push(
      match[1]
        .split(",")
        .map((part) => part.trim().replace(/^'|'$/g, ""))
        .filter(Boolean),
    );
  }
  return filters;
}

describe("ledger revenue statuses vs the SQL rollups", () => {
  const revenue = Array.from(REVENUE_ORDER_STATUSES).sort();

  it("the ledger's revenue set is the paid set plus partially_refunded", () => {
    // Guards the relationship itself, so widening PAID_ORDER_STATUSES (a
    // security-adjacent set — it decides what counts as captured money) cannot
    // silently widen what counts as revenue without this failing.
    expect(revenue).toEqual([...Array.from(PAID_ORDER_STATUSES), "partially_refunded"].sort());
  });

  it("finds the status filters it is asserting on", () => {
    // If the SQL is restructured so these stop matching, this test would
    // otherwise pass vacuously and guard nothing.
    const filters = statusFilters(sql);
    expect(filters.length).toBeGreaterThanOrEqual(4);
  });

  it("every revenue-aggregating function filters on exactly the ledger's revenue statuses", () => {
    // The two revenue rollups and the two live-sales subqueries in
    // admin_ops_summary. admin_customer_rollup is deliberately different — it
    // also counts fully refunded orders, to show a customer's whole history —
    // so it is identified and excluded rather than quietly tolerated.
    // "refunded" (a FULL refund) is never a revenue status — netOrderRevenue
    // gives such an order 0, and counting it would drag average order value
    // down with a $0 denominator. Its presence is what marks a filter as
    // something other than a revenue aggregation.
    const revenueFilters = statusFilters(sql).filter((f) => !f.includes("refunded"));

    expect(revenueFilters.length).toBeGreaterThanOrEqual(4);
    for (const filter of revenueFilters) {
      expect(filter.slice().sort()).toEqual(revenue);
    }
  });

  it("no revenue aggregation sums gross amount_paid without subtracting refunds", () => {
    // A $200 order refunded by $50 is $150. Every place the SQL sums
    // amount_paid for a revenue figure must net the refund off first.
    //
    // THIS ASSERTION USED TO BE A PLACEBO (review finding 5). It read:
    //
    //   sql.match(/sum\(\s*coalesce\(amount_paid[^)]*\)\s*\)/gi)
    //
    // which requires `coalesce` to sit IMMEDIATELY inside `sum(`. It returned
    // ZERO matches against the shipped file while
    // `sum(round(coalesce(amount_paid, 0) * 100))` sat in
    // admin_bulk_savings_stats doing exactly what it claimed to forbid. One
    // intervening call — or any table alias — defeated it completely.
    //
    // Now it finds every `sum(...)` mentioning amount_paid, however nested, and
    // requires refund_amount inside the SAME expression.
    //
    // A textual check is still the WEAKER half of this guard. The strong half is
    // sql/bulk-savings-rollup-executed.test.ts, which executes the shipped
    // definition against a real Postgres and compares it to the ledger.
    const offenders: string[] = [];
    for (const { name, source } of shippedSqlFiles()) {
      for (const expression of sumExpressions(source)) {
        if (!expression.includes("amount_paid")) continue;
        if (expression.includes("refund_amount")) continue;
        offenders.push(`${name}: ${expression.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("no revenue aggregation clamps the refund off at zero", () => {
    // THE TWO SIDES MUST AGREE AT THE OVER-REFUND BOUNDARY TOO, not just about
    // which statuses count. `greatest(0, amount_paid - refund_amount)` here
    // against an unclamped `netOrderRevenue` is a $0-vs-negative disagreement on
    // exactly the orders where the store lost money — the direction that
    // flatters. Neither side may reintroduce the floor alone.
    expect(sql).not.toMatch(/greatest\s*\(\s*0\s*,[^)]*amount_paid/i);
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 150 })).toBe(-50);

    // And the SQL still expresses the subtraction it is being trusted for.
    const netExpressions = sql.match(/coalesce\(amount_paid, 0\) - coalesce\(refund_amount, 0\)/g) ?? [];
    expect(netExpressions.length).toBeGreaterThanOrEqual(6);
  });

  it("finds the sums it is asserting on, and would see a nested one", () => {
    // Guards the guard. The previous version passed on an empty match list,
    // which is indistinguishable from "the regex has gone blind".
    const sums = sumExpressions(sql).filter((expression) => expression.includes("amount_paid"));
    expect(sums.length).toBeGreaterThanOrEqual(4);

    // The exact shape that used to slip through, proved detectable.
    const nested = sumExpressions("select coalesce(sum(round(coalesce(amount_paid, 0) * 100)), 0) as x");
    expect(nested).toContain("sum(round(coalesce(amount_paid, 0) * 100))");
  });
});
