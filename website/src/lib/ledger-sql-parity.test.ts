import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PAID_ORDER_STATUSES, REVENUE_ORDER_STATUSES } from "@/lib/ledger";

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

const SQL_PATH = path.resolve(__dirname, "sql/admin-dashboard-rollups.sql");
const sql = readFileSync(SQL_PATH, "utf8");

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
    const grossSums = sql.match(/sum\(\s*coalesce\(amount_paid[^)]*\)\s*\)/gi) ?? [];
    expect(grossSums).toEqual([]);
  });
});
