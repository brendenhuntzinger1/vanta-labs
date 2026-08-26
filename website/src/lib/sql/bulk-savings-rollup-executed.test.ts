import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// REVIEW FINDING 5 (P2) — A TEXTUAL ASSERTION THAT COULD NOT SEE THE ONE DEFECT
// IN THE FILE IT GUARDED.
//
// ledger-sql-parity.test.ts carries this, written as a behavioural guarantee:
//
//   it("no revenue aggregation sums gross amount_paid without subtracting refunds")
//     const grossSums = sql.match(/sum\(\s*coalesce\(amount_paid[^)]*\)\s*\)/gi) ?? [];
//     expect(grossSums).toEqual([]);
//
// The regex requires `coalesce` to sit IMMEDIATELY inside `sum(`. Line 304 of
// admin-dashboard-rollups.sql is:
//
//   coalesce(sum(round(coalesce(amount_paid, 0) * 100)), 0) as revenue_cents
//
// The intervening `round(` means it never matches. Measured, not assumed: the
// regex returns 0 matches against the shipped file. Any table alias defeats it
// identically.
//
// And what it could not see is real. `admin_bulk_savings_stats` sums GROSS
// amount_paid with NO payment_status filter at all — every pending_payment,
// canceled, failed and fully-refunded order with a bulk tier counted as
// bulk-savings revenue — while the file's own header claims "Every function
// mirrors the JS logic it replaces EXACTLY (same status filters, same
// net-of-refund revenue...)".
//
// THE ANSWER TO A TEXTUAL PLACEBO IS NOT A BETTER REGEX. It is executing the
// function. This runs the SHIPPED definition, parsed out of the file that
// actually deploys, against a real Postgres, and compares it to the ledger.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  // stderr, not console.warn: vitest swallows console output for a skipped
  // module, which is how fourteen dead proofs once reported success (F-014).
  process.stderr.write(
    "[bulk-savings-rollup-executed] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const SQL_PATH = path.resolve(__dirname, "admin-dashboard-rollups.sql");

/**
 * The shipped body of one function, sliced out of the real migration file.
 *
 * Deliberately NOT a copy of the SQL. A test that restates a function body
 * passes while the file that actually deploys says something else — the exact
 * failure mode this file exists to replace.
 */
function shippedFunction(name: string): string {
  const sql = readFileSync(SQL_PATH, "utf8");
  const start = sql.indexOf(`create or replace function public.${name}`);
  if (start < 0) throw new Error(`${name} is not in ${SQL_PATH}`);
  // Function bodies here are $$-quoted; the definition ends at the first `$$;`.
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`${name} has no $$-terminated body`);
  return sql.slice(start, end + 3);
}

/** Just enough of production's `orders` shape for this rollup to act on. */
const SCHEMA = `
create table orders (
  id bigserial primary key,
  order_id text not null unique,
  payment_status text not null default 'paid',
  order_type text not null default 'product',
  bulk_discount_tier text,
  amount_paid numeric not null default 0,
  refund_amount numeric not null default 0
);
`;

/**
 * One basket covering every case that separates gross from net, and sales from
 * reships. All on the 5_percent tier so one row comes back.
 */
const BASKET = [
  { order_id: "b-paid", payment_status: "paid", order_type: "product", amount_paid: 200, refund_amount: 0 },
  { order_id: "b-partial", payment_status: "partially_refunded", order_type: "product", amount_paid: 200, refund_amount: 50 },
  { order_id: "b-refunded", payment_status: "refunded", order_type: "product", amount_paid: 200, refund_amount: 200 },
  { order_id: "b-pending", payment_status: "pending_payment", order_type: "product", amount_paid: 200, refund_amount: 0 },
  { order_id: "b-canceled", payment_status: "canceled", order_type: "product", amount_paid: 200, refund_amount: 0 },
  { order_id: "b-replacement", payment_status: "paid", order_type: "replacement", amount_paid: 15, refund_amount: 0 },
];

/** What the ledger says, derived rather than hand-typed. */
const LEDGER = BASKET.filter((row) => isRevenueOrderStatus(row.payment_status) && isSaleOrder(row.order_type));
const LEDGER_ORDERS = LEDGER.length;
const LEDGER_REVENUE_CENTS = Math.round(LEDGER.reduce((sum, row) => sum + netOrderRevenue(row), 0) * 100);

describeDb("admin_bulk_savings_stats, executed as it ships", () => {
  let client: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "bulk-savings-rollup");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);
    await client.query(shippedFunction("admin_bulk_savings_stats"));
    for (const row of BASKET) {
      await client.query(
        "insert into orders (order_id, payment_status, order_type, bulk_discount_tier, amount_paid, refund_amount) values ($1,$2,$3,'5_percent',$4,$5)",
        [row.order_id, row.payment_status, row.order_type, row.amount_paid, row.refund_amount],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it("the basket separates gross from net, and sales from reships", () => {
    // Anchors the derivation so the expectations below cannot drift silently.
    expect(LEDGER_ORDERS).toBe(2);            // paid + partially refunded
    expect(LEDGER_REVENUE_CENTS).toBe(35000); // $200 + ($200 − $50)
  });

  it("counts only orders that are actually sales", async () => {
    const { rows } = await client.query("select * from public.admin_bulk_savings_stats()");
    const tier = rows.find((r) => r.tier === "5_percent");

    // Was 6: pending, canceled, fully-refunded and a free reship all counted.
    expect(Number(tier?.orders)).toBe(LEDGER_ORDERS);
  });

  it("nets refunds off the revenue instead of summing gross amount_paid", async () => {
    const { rows } = await client.query("select * from public.admin_bulk_savings_stats()");
    const tier = rows.find((r) => r.tier === "5_percent");

    // Was 101500 cents ($1,015.00) against a true $350.00 — gross, unfiltered.
    expect(Number(tier?.revenue_cents)).toBe(LEDGER_REVENUE_CENTS);
  });
});
