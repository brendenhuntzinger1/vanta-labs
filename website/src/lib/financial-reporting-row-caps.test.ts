import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createPostgrestShim, type ShimOptions } from "@/lib/e2e/postgrest-shim";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// BLOCK F — the row caps on the financial reporting surfaces, against a real
// database with more orders than any of them will read.
//
// Production has fifteen orders. Every cap in this file sits between 2,000 and
// 20,000, so production cannot show any of them, and neither can a fake: a
// fake that truncates proves only that the fake truncates. So the five modules
// are run UNMODIFIED against a real Postgres seeded with 21,000 orders, via a
// shim that translates their query-builder calls into SQL and imposes no
// ceiling of its own (src/lib/e2e/postgrest-shim.ts).
//
// Requires a throwaway Postgres. Set VANTA_TEST_DATABASE_URL, e.g.
//
//   VANTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//     npx vitest run src/lib/financial-reporting-row-caps.test.ts
//
// Skipped, loudly, when that is not set.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;

/** Total orders seeded. Chosen to exceed the largest cap in the codebase (20,000). */
const TOTAL_ORDERS = 21_000;

// Every order is one minute older than the last, so "newest N" is exactly
// "lowest N indices" and the caps land on a knowable set of rows.
const NOW = Date.parse("2026-08-26T00:00:00.000Z");

// Index rules — deterministic, no randomness, so the expected counts below are
// arithmetic rather than measurement.
const REFUNDED_AT = 500;          // i % 1000 === 500 → fully refunded
const PARTIAL_AT = 700;           // i % 1000 === 700 → partially refunded
const REPLACEMENT_AT = 900;       // i % 1000 === 900 → $0 reship
const MEMBERSHIP_AT = 300;        // i % 1000 === 300 → membership sale
// i % 1000 === 100 → never paid. amount_paid is still the full total: both
// checkout lanes write finalTotal at INSERT, before capture (payment-service.ts:224,
// express/authorize/route.ts:283), so a pending row is not a $0 row.
const PENDING_AT = 100;
const PER_THOUSAND = TOTAL_ORDERS / 1000; // 21 of each special kind

/** Orders deliberately short by $27. One inside the newest 2,000, five far outside. */
const BROKEN_INDICES = [10, 5_000, 8_000, 12_000, 16_000, 20_000];

const NORMAL_PRODUCT_ORDERS = TOTAL_ORDERS - 5 * PER_THOUSAND; // 20,895
const PAID_STATUS_ORDERS = NORMAL_PRODUCT_ORDERS + PER_THOUSAND + PER_THOUSAND; // + membership + replacement
/**
 * Orders that CONTRIBUTE REVENUE — ledger.REVENUE_ORDER_STATUSES. Owner's
 * decision: a partially refunded order keeps its retained revenue, so it counts
 * here and its refund is netted off the money, not the order.
 */
const REVENUE_ORDERS = PAID_STATUS_ORDERS + PER_THOUSAND; // + partially_refunded
// Revenue SALES: the same set less the $0 reships, which carry a revenue status
// but are not sales (ledger.NON_SALE_ORDER_TYPES, mirrored in the rollup SQL).
// Counting them adds a $0 denominator to average order value.
const REVENUE_SALES = REVENUE_ORDERS - PER_THOUSAND;
const PROFIT_ELIGIBLE_ORDERS = REVENUE_ORDERS;

const SCHEMA = `
drop table if exists commissions;
drop table if exists order_items;
drop table if exists orders;

create table orders (
  id bigserial primary key,
  order_id text not null unique,
  order_number text,
  customer_email text,
  order_type text not null default 'product',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  tax_rate_percent numeric(6,3),
  tax_state text,
  state text,
  amount_paid numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  card_processing_fee numeric(12,2) not null default 0,
  handling_fee numeric(12,2) not null default 0,
  shipping_protection_fee numeric(12,2) not null default 0,
  store_credit_redeemed_cents integer not null default 0,
  points_redeemed integer not null default 0,
  payment_method text,
  payment_status text not null,
  fulfillment_status text not null default 'awaiting_fulfillment',
  actual_shipping_cost_cents integer,
  shipping_cost_source text,
  profit_finalized boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null
);

create table order_items (
  id bigserial primary key,
  order_id text not null,
  quantity integer not null default 1,
  unit_cost_cents integer
);

create table commissions (
  id bigserial primary key,
  order_id text not null,
  commission_amount numeric(12,2) not null default 0,
  payment_status text not null default 'pending'
);
`;

// One INSERT ... SELECT over generate_series: 21,000 rows in a single
// statement, and the rules are visible as SQL rather than buried in a loop.
const SEED = `
insert into orders (
  order_id, order_number, customer_email, order_type, subtotal, shipping_amount,
  tax_amount, tax_rate_percent, tax_state, state, amount_paid, refund_amount,
  card_processing_fee, payment_method, payment_status, paid_at, created_at
)
select
  'order-' || lpad(i::text, 6, '0'),
  'VL-' || lpad(i::text, 6, '0'),
  'buyer' || i || '@example.test',
  case when i % 1000 = ${REPLACEMENT_AT} then 'replacement'
       when i % 1000 = ${MEMBERSHIP_AT} then 'membership'
       else 'product' end,
  case when i % 1000 = ${REPLACEMENT_AT} then 0
       when i % 1000 = ${MEMBERSHIP_AT} then 99
       else 100 end,
  case when i % 1000 in (${REPLACEMENT_AT}, ${MEMBERSHIP_AT}) then 0 else 10 end,
  case when i % 1000 in (${REPLACEMENT_AT}, ${MEMBERSHIP_AT}) then 0 else 8 end,
  case when i % 1000 in (${REPLACEMENT_AT}, ${MEMBERSHIP_AT}) then null else 8.000 end,
  case when i % 1000 in (${REPLACEMENT_AT}, ${MEMBERSHIP_AT}) then null
       when i % 2 = 0 then 'CA' else 'TX' end,
  case when i % 2 = 0 then 'California' else 'Texas' end,
  case when i = any (array[${BROKEN_INDICES.join(",")}]) then 100
       when i % 1000 = ${REPLACEMENT_AT} then 0
       when i % 1000 = ${MEMBERSHIP_AT} then 99
       else 127 end,
  case when i % 1000 = ${REFUNDED_AT} then 127
       when i % 1000 = ${PARTIAL_AT} then 50
       else 0 end,
  case when i % 1000 in (${REPLACEMENT_AT}, ${MEMBERSHIP_AT}) then 0 else 9 end,
  case when i % 1000 = ${REPLACEMENT_AT} then 'replacement' else 'card' end,
  case when i % 1000 = ${REFUNDED_AT} then 'refunded'
       when i % 1000 = ${PARTIAL_AT} then 'partially_refunded'
       when i % 1000 = ${PENDING_AT} then 'pending_payment'
       else 'paid' end,
  case when i % 1000 = ${PENDING_AT} then null
       else to_timestamp(${NOW / 1000} - i * 60) end,
  to_timestamp(${NOW / 1000} - i * 60)
from generate_series(0, ${TOTAL_ORDERS - 1}) as i;

insert into order_items (order_id, quantity, unit_cost_cents)
select order_id, 2, 1000 from orders where order_type <> 'membership';
`;

// The shim is swapped per-test, so the mock reads a module-level handle.
let activeClient: Client;
let activeOptions: ShimOptions = {};
function shim() {
  return createPostgrestShim(activeClient, activeOptions);
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return shim(); },
}));
vi.mock("@/lib/admin-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-control")>();
  return {
    ...actual,
    // Config, not the thing under test. Fixed so profit is arithmetic.
    getProfitSettings: async () => ({
      minProfitPercent: 0,
      minProfitDollars: 0,
      worstCaseUnitCost: 33,
      processingFeePercent: 8,
      processingFeeIncludesTax: true,
      countSalesTaxAsProfit: true,
      shippingCostPerOrder: 6,
    }),
  };
});

const describeDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  console.warn(
    "[financial-reporting-row-caps] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run the 21,000-order row-cap proofs.",
  );
}

describeDb("financial reporting at 21,000 orders", () => {
  let client: Client;

  beforeAll(async () => {
    // Its own database — the two Block F suites both build an `orders`
    // table and vitest runs files in parallel (Rule 5).
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "row-caps");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);
    await client.query(SEED);
    activeClient = client;
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(() => {
    activeOptions = {};
  });

  it("seeded the dataset the caps are measured against", async () => {
    const total = await client.query("select count(*)::int as c from orders");
    expect(total.rows[0].c).toBe(TOTAL_ORDERS);

    const paid = await client.query(
      "select count(*)::int as c from orders where payment_status in ('paid','completed','succeeded')",
    );
    expect(paid.rows[0].c).toBe(PAID_STATUS_ORDERS);

    const revenue = await client.query(
      "select count(*)::int as c from orders where payment_status in ('paid','completed','succeeded','partially_refunded')",
    );
    expect(revenue.rows[0].c).toBe(REVENUE_ORDERS);

    const partial = await client.query("select count(*)::int as c from orders where payment_status = 'partially_refunded'");
    expect(partial.rows[0].c).toBe(PER_THOUSAND);
  });

  // -------------------------------------------------------------------------
  // F-01 — the reconciliation screen must see a mismatch however old it is.
  //
  // BEFORE THE FIX this asserted the opposite and passed: `.limit(2000)` meant
  // only order-000010 was ever flagged, and the five older broken orders were
  // invisible on the one screen an operator opens BECAUSE they think the ledger
  // is wrong.
  // -------------------------------------------------------------------------
  it("reconciliation flags every mismatched order, not just the newest 2,000", async () => {
    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();
    const mismatches = flags.filter((f) => f.type === "total_mismatch").map((f) => f.orderId).sort();

    const expectedAll = BROKEN_INDICES.map((i) => `order-${String(i).padStart(6, "0")}`).sort();
    expect(expectedAll).toHaveLength(6);
    // Only ONE of the six is inside the old 2,000-row window.
    expect(expectedAll.filter((id) => Number(id.slice(-6)) < 2000)).toHaveLength(1);
    expect(mismatches).toEqual(expectedAll);
  }, 300_000);

  // -------------------------------------------------------------------------
  // F-02 — the profit dashboard asks for 20,000 rows and there are 21,000.
  // Every lifetime figure on /admin is computed from the short read, with no
  // flag, no warning and no error.
  // -------------------------------------------------------------------------
  it("the profit dashboard counts the whole order history, not the newest 20,000", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const dashboard = await getProfitDashboard(NOW);

    // Ground truth for the same predicate the dashboard uses (paid or
    // partially refunded, replacements counted separately).
    const truth = await client.query(`
      select
        count(*) filter (where order_type <> 'replacement')::int as sales,
        count(*) filter (where order_type = 'replacement')::int as replacements
      from orders
      where payment_status in ('paid','completed','succeeded','partially_refunded')
    `);
    expect(truth.rows[0].sales + truth.rows[0].replacements).toBe(PROFIT_ELIGIBLE_ORDERS);

    expect(dashboard.lifetime.orderCount).toBe(truth.rows[0].sales);
    expect(dashboard.lifetime.replacementCount).toBe(truth.rows[0].replacements);
    expect(dashboard.truncated).toBe(false);

    // BEFORE THE FIX: 19,940 sales + 20 reships = 19,960 of 20,958, gross
    // revenue $2,531,820 instead of the full history, and nothing said so.
    expect(dashboard.lifetime.orderCount + dashboard.lifetime.replacementCount).toBe(PROFIT_ELIGIBLE_ORDERS);
    expect(dashboard.lifetime.grossRevenue).toBeGreaterThan(2_531_820);
  }, 300_000);

  // -------------------------------------------------------------------------
  // F-03 — the revenue page's legacy fallback caps at 10,000. The RPC path is
  // uncapped, so the SAME page reports two different totals depending only on
  // whether one migration has been run.
  // -------------------------------------------------------------------------
  it("the revenue fallback caps at 10,000 orders while the RPC path does not", async () => {
    // Loaded from the migration file that ships, NOT retyped here. An inline
    // copy is a fifth hand-written definition of "revenue" — precisely the
    // thing this block exists to stamp out — and it would let the test keep
    // passing after the real SQL changed.
    const sqlFile = readFileSync(path.resolve(__dirname, "sql/admin-dashboard-rollups.sql"), "utf8");
    for (const fn of ["admin_revenue_summary", "admin_revenue_by_method"]) {
      const from = sqlFile.indexOf(`create or replace function public.${fn}`);
      const to = sqlFile.indexOf("$$;", from) + 3;
      // The grants at the end of the file reference roles a throwaway cluster
      // does not have; only the function bodies are needed here.
      await client.query(sqlFile.slice(from, to).replace(/public\./g, ""));
    }

    const { getRevenueMetrics } = await import("@/lib/admin-revenue");

    const viaRpc = await getRevenueMetrics();
    expect(viaRpc.totalPaidOrders).toBe(REVENUE_SALES);

    // Same code, same data, RPC not migrated yet.
    activeOptions = { missingRpcs: new Set(["admin_revenue_summary", "admin_revenue_by_method"]) };
    const viaFallback = await getRevenueMetrics();

    // BEFORE THE FIX: 10,000 orders / $1,268,369 here against 20,937 /
    // $2,655,582 from the RPC — the same page, the same data, and which number
    // you saw depended only on whether one migration had been run.
    expect(viaFallback.totalPaidOrders).toBe(REVENUE_SALES);
    expect(viaFallback.totalPaidRevenue).toBeCloseTo(viaRpc.totalPaidRevenue, 2);
    expect(viaFallback.averageOrderValue).toBeCloseTo(viaRpc.averageOrderValue, 2);
  }, 300_000);

  // -------------------------------------------------------------------------
  // F-04 — the sales-tax filing report pages 20 times and stops. There are
  // 20,958 orders carrying tax. The rows past 20,000 are not remitted, and the
  // report says nothing.
  // -------------------------------------------------------------------------
  it("the sales-tax report covers every taxed order past the old 20-page ceiling", async () => {
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    const withTax = await client.query(`
      select count(*)::int as c, round(sum(tax_amount), 2)::float as tax from orders
      where tax_amount > 0 and payment_status in ('paid','completed','succeeded','partially_refunded','refunded')
    `);
    expect(withTax.rows[0].c).toBeGreaterThan(20_000);

    // BEFORE THE FIX: 19,960 rows, $159,520 collected — 977 taxed orders and
    // $7,976 of collections simply absent from a filing document.
    expect(report.rows).toHaveLength(withTax.rows[0].c);
    expect(report.truncated).toBe(false);
    expect(report.totals.taxCollected).toBeCloseTo(withTax.rows[0].tax, 2);
  }, 300_000);

  // -------------------------------------------------------------------------
  // F-05 — the two order counts in admin-profit.ts disagree with each other,
  // by exactly the replacements, exactly as that file's own docblock says they
  // must not.
  // -------------------------------------------------------------------------
  it("the 30-day order count and the lifetime order count agree on what a sale is", async () => {
    const { getProfitWindowMetrics, getProfitDashboard } = await import("@/lib/admin-profit");
    // Every seeded order is inside the 30-day window (21,000 minutes ≈ 14.6 days),
    // so the two surfaces are counting exactly the same set of orders.
    const window = await getProfitWindowMetrics(NOW);
    const dashboard = await getProfitDashboard(NOW);

    expect(dashboard.lifetime.replacementCount).toBe(PER_THOUSAND);
    // BEFORE THE FIX: 20,958 here against 19,940 on the lifetime tile — the 21
    // reships counted as sales in one place and not the other, in the same file.
    expect(window.ordersLast30Days).toBe(PROFIT_ELIGIBLE_ORDERS - PER_THOUSAND);
    expect(window.ordersLast30Days).toBe(dashboard.lifetime.orderCount);
  }, 300_000);

  // -------------------------------------------------------------------------
  // F-06 — MODELLED, not observed. PostgREST applies db-max-rows to every
  // response; Supabase exposes it as "Max rows" and ships it at 1000. The
  // select in profitForPaidOrdersInRange had no defence against it: it did not
  // ask how many rows existed, and could not tell a short read from a small
  // store.
  //
  // Whether this project has that setting at 1000 is NOT established here —
  // see BLOCK-F.md, it needs the owner. The point of the fix is that the answer
  // stops mattering.
  // -------------------------------------------------------------------------
  it("MODEL: a db-max-rows cap no longer changes any reported number", async () => {
    const { getProfitWindowMetrics } = await import("@/lib/admin-profit");
    const uncapped = await getProfitWindowMetrics(NOW);

    // Every response the source returns is capped — deliberately at a size that
    // is NOT a multiple of the page size, so a page can come back short without
    // the source being exhausted. That is the case a "stop when a page is
    // short" reader gets wrong, and it is why readAllRows stops only on empty.
    activeOptions = { maxRows: 750 };
    const capped = await getProfitWindowMetrics(NOW);

    // BEFORE THE FIX the capped run reported the cap as the order count and a
    // fraction of the profit, with no error and no flag. Paging advances by the
    // rows actually received, so a cap now costs round trips, not accuracy.
    expect(capped.ordersLast30Days).toBe(uncapped.ordersLast30Days);
    expect(capped.last30Days).toBeCloseTo(uncapped.last30Days, 2);
  }, 300_000);
});
