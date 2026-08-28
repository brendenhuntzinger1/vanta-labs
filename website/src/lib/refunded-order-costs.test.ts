import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createPostgrestShim } from "@/lib/e2e/postgrest-shim";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// VL-24 / M-02 / REF-05 — A REFUND RETURNS THE REVENUE. IT DOES NOT RETURN THE
// COGS, THE POSTAGE OR THE PROCESSOR FEE.
//
// The profit report built its order set with `isRevenueOrderStatus`, which
// deliberately excludes a fully refunded order (netOrderRevenue would be 0, and
// counting it on /admin/revenue would drag average order value down with a $0
// denominator). Correct there — and wrong here, because dropping the ROW drops
// its COSTS with it:
//
//   • the vials were picked, packed and posted, and they did not come back
//   • the shipping label was bought and used
//   • the processor keeps its fee on a refunded charge
//
// So every full refund silently ERASED real money the store had spent, and net
// profit was overstated by exactly the amount the store lost. The worse the
// refund, the better the dashboard looked.
//
// The figures below are worked out by hand from the config, not derived from
// the module under test:
//
//   A — PAID          $100 merch + $10 shipping, $110 taken, $30 COGS
//       revenue 110, processing 11.00, shipping cost 6, COGS 30 -> profit  63.00
//   B — FULLY REFUNDED  same order, $110 taken and $110 handed back
//       revenue   0, processing 11.00, shipping cost 6, COGS 30 -> profit −47.00
//   C — NEVER PAID     an abandoned $110 attempt: no money, no costs, no row
//
//   lifetime net profit = 63.00 − 47.00 = 16.00   (was 63.00 — the whole loss
//                                                  on B was invisible)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const NOW = Date.parse("2026-08-26T00:00:00.000Z");

const CONFIG = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: 10,
  processingFeeIncludesTax: true,
  countSalesTaxAsProfit: false,
  shippingCostPerOrder: 6,
};

const SCHEMA = `
drop table if exists order_items; drop table if exists commissions; drop table if exists orders;
create table orders (
  id bigserial primary key, order_id text not null unique, order_number text, customer_email text,
  order_type text not null default 'product', subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0, discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0, tax_rate_percent numeric(6,3), tax_state text, state text,
  amount_paid numeric(12,2) not null default 0, refund_amount numeric(12,2) not null default 0,
  card_processing_fee numeric(12,2) not null default 0, handling_fee numeric(12,2) not null default 0,
  shipping_protection_fee numeric(12,2) not null default 0,
  store_credit_redeemed_cents integer not null default 0, points_redeemed integer not null default 0,
  payment_method text, payment_status text not null, fulfillment_status text not null default 'awaiting_fulfillment',
  actual_shipping_cost_cents integer, shipping_cost_source text, profit_finalized boolean not null default false,
  paid_at timestamptz, created_at timestamptz not null);
create table order_items (id bigserial primary key, order_id text not null, quantity integer not null default 1, unit_cost_cents integer);
create table commissions (id bigserial primary key, order_id text not null, commission_amount numeric(12,2) not null default 0, status text not null default 'pending');
`;

let activeClient: Client;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return createPostgrestShim(activeClient, {}); },
}));
vi.mock("@/lib/admin-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-control")>()),
  getProfitSettings: async () => CONFIG,
}));

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn("[refunded-order-costs] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres.");
}

describeDb("a fully refunded order keeps every cost it really incurred", () => {
  let client: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "refundedcosts");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);

    const seed = async (
      orderId: string, status: string, paid: number, refund: number, cogsCents: number, minutesAgo: number,
    ) => {
      const at = new Date(NOW - minutesAgo * 60_000).toISOString();
      await client.query(
        `insert into orders (order_id, order_number, customer_email, order_type, subtotal, shipping_amount,
           amount_paid, refund_amount, payment_method, payment_status, paid_at, created_at)
         values ($1,$1,'buyer@example.test','product',100,10,$2,$3,'card',$4,$5,$5)`,
        [orderId, paid, refund, status, at],
      );
      if (cogsCents > 0) {
        await client.query(`insert into order_items (order_id, quantity, unit_cost_cents) values ($1, 1, $2)`, [orderId, cogsCents]);
      }
    };

    await seed("order-paid", "paid", 110, 0, 3000, 10);
    await seed("order-refunded", "refunded", 110, 110, 3000, 20);
    // Never took a cent. It must stay out of the report — widening the filter
    // to catch refunds must not sweep in orders that were only ever attempted.
    await seed("order-unpaid", "pending_payment", 110, 0, 3000, 30);

    activeClient = client;
  }, 60_000);

  afterAll(async () => { await client?.end(); });

  it("the per-order figure was always right — it is the report that dropped it", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");
    const p = (await getOrderProfit("order-refunded"))!;

    expect(p.revenue).toBeCloseTo(0, 2);
    expect(p.cogs).toBeCloseTo(30, 2);
    expect(p.shippingCost).toBeCloseTo(6, 2);
    expect(p.processingFee).toBeCloseTo(11, 2);
    expect(p.profit).toBeCloseTo(-47, 2);
  }, 60_000);

  it("counts the refunded order's COGS, postage and processor fee on the dashboard", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const d = await getProfitDashboard(NOW);

    // BOTH orders' costs, not just the one that kept its money.
    expect(d.lifetime.totalProductCosts).toBeCloseTo(60, 2);
    expect(d.lifetime.totalProcessorFees).toBeCloseTo(22, 2);
    expect(d.lifetime.totalShippingExpense).toBeCloseTo(12, 2);

    // 63.00 kept − 47.00 lost. Before the fix this read 63.00.
    expect(d.lifetime.netProfit).toBeCloseTo(16, 2);
    expect(d.profit.lifetime).toBeCloseTo(16, 2);
  }, 60_000);

  it("shows the refund rather than hiding it inside gross revenue", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const d = await getProfitDashboard(NOW);

    // Gross revenue is money invoiced BEFORE refunds — the same convention a
    // partial refund already gets — so the refund needs its own line or the
    // reader cannot tell $220 of gross from $220 of kept money.
    expect(d.lifetime.grossRevenue).toBeCloseTo(220, 2);
    expect(d.lifetime.totalRefunds).toBeCloseTo(110, 2);
    expect(d.lifetime.orderCount).toBe(2);
  }, 60_000);

  it("keeps orders that never took payment out of every figure", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const d = await getProfitDashboard(NOW);

    // Three rows in the table; the unpaid attempt is not one of the two orders,
    // and its $30 of stock cost is not an expense — nothing was shipped.
    expect(d.lifetime.orderCount).toBe(2);
    expect(d.lifetime.totalProductCosts).toBeCloseTo(60, 2);
  }, 60_000);

  it("carries the loss into the windowed profit and the trend", async () => {
    const { getProfitWindowMetrics, getProfitTrend } = await import("@/lib/admin-profit");

    // Both orders are seeded minutes before midnight UTC, so they land in the
    // 7- and 30-day windows rather than "today".
    const windows = await getProfitWindowMetrics(NOW);
    expect(windows.last30Days).toBeCloseTo(16, 2);
    expect(windows.last7Days).toBeCloseTo(16, 2);

    const trend = await getProfitTrend(new Date(NOW - 3 * 86_400_000).toISOString(), new Date(NOW).toISOString());
    const total = trend.reduce((sum, point) => sum + point.profit, 0);
    expect(total).toBeCloseTo(16, 2);
  }, 60_000);
});
