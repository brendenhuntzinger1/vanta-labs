import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// TWO METRIC DEFINITIONS THAT WERE OWNER DECISIONS, NOW SETTLED — AND THE
// REASON THEY EACH NEED A GUARD IS THE SAME: every one of them exists TWICE.
//
// Each figure is computed by a Postgres RPC (the primary path) and again in
// TypeScript (the fallback for an environment where the rollup migration has
// not been applied). If the two drift, the number a person reads on /admin
// depends on whether a migration happens to be present — which is not a
// difference anybody looking at the screen can see.
//
// ADM-11 / VL-PARITY-01 — "Live sales today / this month" is keyed on paid_at.
//
//   Revenue is recognised when the money arrives, not when the cart was
//   submitted. created_at counted an order placed today and never paid, and
//   missed one placed yesterday and paid this morning. It also disagreed with
//   /admin/revenue, which has always keyed on paid_at — so two admin screens
//   could print different totals for the same "today" and both be behaving as
//   written.
//
//   Measured against production before changing it, which is why it was done
//   now rather than deferred: 7 revenue-bearing orders, 0 with a null paid_at,
//   0 paid on a different day than they were created. No displayed figure
//   moved, and the legacy-null case that would have forced a coalesce()
//   compromise does not exist in this database.
//
// M-14 — the customer "Orders" count excludes warranty replacements.
//
//   admin-replacements.ts writes a reship as a paid, $0 order under the
//   ORIGINAL BUYER'S email. It is the store's own shipment, not an order the
//   customer placed, and counting it grew that customer's apparent order
//   history the more the store had to reship them.
//
//   The STATUS filter stays absent on purpose: order_count means "orders this
//   person placed", which legitimately includes cancelled and unpaid ones.
//   total_spent is the column that filters on status. Those are two different
//   questions and admin-customers-revenue.test.ts pins that split.
// ---------------------------------------------------------------------------

const ROLLUPS = "src/lib/sql/admin-dashboard-rollups.sql";
const PORTAL = "src/lib/partner-portal.ts";
const CUSTOMERS = "src/lib/admin-customers.ts";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * Comment lines stripped. The prose above each fix quotes the very predicate
 * being banned, and an assertion that matches its own explanation is an
 * assertion that cannot fail — this codebase has been bitten by that twice.
 */
function code(path: string): string {
  return read(path)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("--") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** The body of one `create ... function <name>` block in the rollups file. */
function sqlFunction(name: string): string {
  const src = code(ROLLUPS);
  const start = src.indexOf(`function public.${name}(`);
  expect(start, `${name} not found in ${ROLLUPS}`).toBeGreaterThan(-1);
  const next = src.indexOf("create or replace function", start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("ADM-11: live sales is money received, on both paths", () => {
  it("admin_ops_summary keys both live-sales windows on paid_at", () => {
    const fn = sqlFunction("admin_ops_summary");

    // Both windows — today and month — and each guarded against a null paid_at.
    expect([...fn.matchAll(/paid_at is not null and paid_at >= p_(today|month)_start/g)]).toHaveLength(2);
  });

  it("admin_ops_summary no longer keys live sales on created_at", () => {
    // The defect, stated as source. `created_at` may still appear elsewhere in
    // the file (other functions legitimately use it); what must not survive is
    // a live-sales window keyed on it.
    const fn = sqlFunction("admin_ops_summary");
    expect(fn).not.toMatch(/created_at >= p_(today|month)_start/);
  });

  it("agrees with admin_revenue_summary, which is the whole point", () => {
    // If /admin/revenue ever moves off paid_at, this must move with it or the
    // two screens silently disagree about the same day again.
    const revenue = sqlFunction("admin_revenue_summary");
    expect(revenue).toMatch(/paid_at is not null and paid_at >= p_start_of_today/);
  });

  it("the TypeScript fallback uses the same basis as the RPC", () => {
    const src = code(PORTAL);
    expect(src).toContain('.gte("paid_at", todayStart)');
    expect(src).toContain('.gte("paid_at", monthStart)');
    expect(src).not.toContain('.gte("created_at", todayStart)');
    expect(src).not.toContain('.gte("created_at", monthStart)');
  });
});

describe("M-14: a warranty reship is not an order the customer placed", () => {
  it("admin_customer_rollup excludes replacements from both of its CTEs", () => {
    const fn = sqlFunction("admin_customer_rollup");

    // `agg` produces order_count and total_spent; `named` picks the display
    // name off the most recent row. Excluding from only one would leave the
    // count right and the name taken from a reship, or the reverse.
    expect([...fn.matchAll(/coalesce\(order_type, 'product'\) <> 'replacement'/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("the TypeScript twin excludes them too", () => {
    expect(code(CUSTOMERS)).toContain('.neq("order_type", "replacement")');
  });

  it("still counts every status, because placing an order is not paying for one", () => {
    // Guards against over-correcting: order_count must NOT gain a status
    // filter. A cancelled order is still an order this customer placed, and
    // admin-customers-revenue.test.ts asserts that deliberately.
    const fn = sqlFunction("admin_customer_rollup");
    const agg = fn.slice(fn.indexOf("with agg as"), fn.indexOf("named as"));
    expect(agg).toContain("count(*) as order_count");
    expect(agg).not.toMatch(/count\(\*\)\s*filter\s*\(/);
  });
});
