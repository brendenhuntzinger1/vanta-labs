import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPostgrestShim, type ShimOptions } from "@/lib/e2e/postgrest-shim";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// BLOCK F — the four surfaces agree, against one dataset, on the owner's rules.
//
// RULE 1. A partial refund keeps its retained revenue. A $200 order refunded by
//         $50 is $150 of revenue, and it is still an order.
// RULE 2. Collected sales tax is NOT revenue and NOT profit. It is a liability
//         held on behalf of a state, tracked separately.
// RULE 3. revenue − COGS − processor fees − shipping costs = business profit.
//         (Discounts are already inside revenue: `subtotal − discount_amount`
//         is what the order records. Ambassador commission is a real cost the
//         store pays and is deducted as well — flagged for the owner, since it
//         is not in the formula as they wrote it.)
//
// Every number below is arithmetic from a hand-built ledger of nine orders, so
// a surface can only agree by being right, not by matching another surface that
// is equally wrong. Requires VANTA_TEST_DATABASE_URL.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const NOW = Date.parse("2026-08-26T00:00:00.000Z");

/** Fixed profit config. Sales tax is a liability, per RULE 2. */
const CONFIG = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: 10,
  processingFeeIncludesTax: true,
  countSalesTaxAsProfit: false,
  shippingCostPerOrder: 6,
};

// The ledger, written out in full. Each order: subtotal, discount, shipping,
// tax, card surcharge, amount_paid, refund, status, type.
// amount_paid = subtotal − discount + shipping + tax + cardFee.
interface Seed {
  n: number; subtotal: number; discount: number; shipping: number; tax: number;
  cardFee: number; paid: number; refund: number; status: string; type: string;
  cogsCents: number;
}
const LEDGER: Seed[] = [
  // Four clean paid orders.
  { n: 1, subtotal: 200, discount: 0, shipping: 10, tax: 16, cardFee: 9, paid: 235, refund: 0, status: "paid", type: "product", cogsCents: 6000 },
  { n: 2, subtotal: 100, discount: 20, shipping: 10, tax: 6.4, cardFee: 4, paid: 100.4, refund: 0, status: "paid", type: "product", cogsCents: 3000 },
  { n: 3, subtotal: 50, discount: 0, shipping: 0, tax: 4, cardFee: 2, paid: 56, refund: 0, status: "paid", type: "product", cogsCents: 1500 },
  { n: 4, subtotal: 300, discount: 30, shipping: 10, tax: 22.4, cardFee: 12, paid: 314.4, refund: 0, status: "paid", type: "product", cogsCents: 9000 },
  // THE HEADLINE CASE: a $200 order refunded by $50 → $150 of revenue.
  { n: 5, subtotal: 200, discount: 0, shipping: 0, tax: 0, cardFee: 0, paid: 200, refund: 50, status: "partially_refunded", type: "product", cogsCents: 6000 },
  // A fully refunded order: no revenue, and its tax comes back off the liability.
  { n: 6, subtotal: 100, discount: 0, shipping: 10, tax: 8, cardFee: 4, paid: 122, refund: 122, status: "refunded", type: "product", cogsCents: 3000 },
  // A never-paid order: no revenue, no tax liability.
  { n: 7, subtotal: 100, discount: 0, shipping: 10, tax: 8, cardFee: 4, paid: 122, refund: 0, status: "pending_payment", type: "product", cogsCents: 3000 },
  // A $0 reship: real cost, zero revenue, never a sale.
  { n: 8, subtotal: 0, discount: 0, shipping: 0, tax: 0, cardFee: 0, paid: 0, refund: 0, status: "paid", type: "replacement", cogsCents: 3000 },
  // A membership: revenue, no COGS, never ships.
  { n: 9, subtotal: 99, discount: 0, shipping: 0, tax: 0, cardFee: 0, paid: 99, refund: 0, status: "paid", type: "membership", cogsCents: 0 },
];

const id = (n: number) => `order-${String(n).padStart(4, "0")}`;
const revenueStatuses = new Set(["paid", "completed", "succeeded", "partially_refunded"]);
// A reship is not a sale. It is `paid` with amount_paid 0, so a filter on status
// alone counts it as an order and divides revenue by a denominator that includes
// it — the same exclusion `ledger.NON_SALE_ORDER_TYPES` and the rollup SQL apply.
// Revenue is unchanged by it (order #8 is $0); the ORDER COUNT is not.
const nonSaleTypes = new Set(["replacement"]);

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
create table commissions (id bigserial primary key, order_id text not null, commission_amount numeric(12,2) not null default 0, payment_status text not null default 'pending');
`;

let activeClient: Client;
let activeOptions: ShimOptions = {};
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return createPostgrestShim(activeClient, activeOptions); },
}));
vi.mock("@/lib/admin-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-control")>()),
  getProfitSettings: async () => CONFIG,
}));

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn("[financial-reporting-consistency] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres.");
}

describeDb("the four surfaces agree on the owner's rules", () => {
  let client: Client;

  beforeAll(async () => {
    // Its own database — the two Block F suites both build an `orders`
    // table and vitest runs files in parallel (Rule 5).
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "consistency");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);
    for (const o of LEDGER) {
      await client.query(
        `insert into orders (order_id, order_number, customer_email, order_type, subtotal, shipping_amount,
           discount_amount, tax_amount, tax_rate_percent, tax_state, state, amount_paid, refund_amount,
           card_processing_fee, payment_method, payment_status, paid_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,8,'CA','California',$9,$10,$11,$12,$13,$14,$14)`,
        [id(o.n), `VL-${o.n}`, `b${o.n}@example.test`, o.type, o.subtotal, o.shipping, o.discount, o.tax,
         o.paid, o.refund, o.cardFee, o.type === "replacement" ? "replacement" : "card", o.status,
         new Date(NOW - o.n * 60_000).toISOString()],
      );
      if (o.cogsCents > 0) {
        await client.query(`insert into order_items (order_id, quantity, unit_cost_cents) values ($1, 1, $2)`, [id(o.n), o.cogsCents]);
      }
    }
    // The real rollup functions, loaded from the migration file itself so this
    // tests the SQL that ships rather than a copy of it. The grants at the end
    // reference roles this throwaway cluster does not have, so they are dropped.
    const sqlFile = readFileSync(path.resolve(__dirname, "sql/admin-dashboard-rollups.sql"), "utf8");
    for (const fn of ["admin_revenue_summary", "admin_revenue_by_method"]) {
      const start = sqlFile.indexOf(`create or replace function public.${fn}`);
      const end = sqlFile.indexOf("$$;", start) + 3;
      await client.query(sqlFile.slice(start, end).replace(/public\./g, ""));
    }
    activeClient = client;
  }, 60_000);

  afterAll(async () => { await client?.end(); });

  // -- the arithmetic, derived from LEDGER rather than typed in --------------
  const revenueOrders = LEDGER.filter((o) => revenueStatuses.has(o.status) && !nonSaleTypes.has(o.type));
  const netRevenueGross = revenueOrders.reduce((s, o) => s + (o.paid - o.refund), 0);
  const taxLiability = LEDGER.filter((o) => revenueStatuses.has(o.status)).reduce((s, o) => s + o.tax, 0);

  it("the headline case: a $200 order refunded by $50 is $150 of revenue", () => {
    const o = LEDGER.find((x) => x.n === 5)!;
    expect(o.paid - o.refund).toBe(150);
  });

  it("the revenue page counts partially refunded orders and nets their refund", async () => {
    const { getRevenueMetrics } = await import("@/lib/admin-revenue");
    const viaRpc = await getRevenueMetrics();

    // 6 revenue SALES: #1 235, #2 100.40, #3 56, #4 314.40, #5 150, #9 99.
    // #8 is a $0 reship — revenue-status, but not a sale, so it is not an order.
    expect(viaRpc.totalPaidOrders).toBe(revenueOrders.length);
    expect(viaRpc.totalPaidRevenue).toBeCloseTo(netRevenueGross, 2);

    // The same answer with the migration not yet run.
    activeOptions = { missingRpcs: new Set(["admin_revenue_summary", "admin_revenue_by_method"]) };
    const viaFallback = await getRevenueMetrics();
    activeOptions = {};

    expect(viaFallback.totalPaidOrders).toBe(viaRpc.totalPaidOrders);
    expect(viaFallback.totalPaidRevenue).toBeCloseTo(viaRpc.totalPaidRevenue, 2);

    // Order #5 is the whole point: excluded before, worth $150 now.
    expect(viaRpc.totalPaidRevenue).toBeCloseTo(235 + 100.4 + 56 + 314.4 + 150 + 99, 2);
    // Excluding the reship must not move the money, only the count — it is $0.
    expect(viaRpc.totalPaidOrders).toBe(6);
  }, 60_000);

  it("the profit dashboard treats sales tax as a liability, not as revenue or profit", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const d = await getProfitDashboard(NOW);

    expect(d.salesTaxCountedAsProfit).toBe(false);
    expect(d.salesTaxCollected).toBeCloseTo(taxLiability, 2);
    expect(d.salesTaxCollected).toBeGreaterThan(0);

    // Gross revenue excludes every cent of that tax.
    const revenueExTax = revenueOrders.reduce(
      (s, o) => s + (o.subtotal - o.discount) + o.shipping + o.cardFee, 0,
    );
    expect(d.lifetime.grossRevenue).toBeCloseTo(revenueExTax, 2);
  }, 60_000);

  it("a partial refund reduces revenue by the refund and nothing else", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");
    const p = (await getOrderProfit(id(5)))!;

    // $200 merchandise, no shipping, no tax, no surcharge; $50 back.
    expect(p.grossRevenue).toBeCloseTo(200, 2);
    expect(p.revenue).toBeCloseTo(150, 2);
    // COGS is NOT reduced — the goods went out and did not come back.
    expect(p.cogs).toBeCloseTo(60, 2);
    // revenue − COGS − processing − shipping = 150 − 60 − 20 − 6 = 64.
    expect(p.processingFee).toBeCloseTo(20, 2);
    expect(p.shippingCost).toBeCloseTo(6, 2);
    expect(p.profit).toBeCloseTo(64, 2);
  }, 60_000);

  it("a fully refunded order keeps its cost and loses all its revenue", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");
    const p = (await getOrderProfit(id(6)))!;

    // $122 back on a $122 charge, of which $8 was tax that was never revenue.
    // Revenue must land on 0, not on −8.
    expect(p.revenue).toBeCloseTo(0, 2);
    expect(p.cogs).toBeCloseTo(30, 2);
  }, 60_000);

  it("the sales-tax report's net tax equals the profit dashboard's liability", async () => {
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const report = await getSalesTaxReport();
    const d = await getProfitDashboard(NOW);

    // The tax report sees every taxed order that took money, including the
    // fully refunded one, and nets its refund back off.
    //   collected: #1 16 + #2 6.40 + #3 4 + #4 22.40 + #6 8 = 56.80
    //   refunded:  #6 8 (in full)                           =  8.00
    //   net                                                  = 48.80
    expect(report.totals.taxCollected).toBeCloseTo(16 + 6.4 + 4 + 22.4 + 8, 2);
    expect(report.totals.taxRefunded).toBeCloseTo(8, 2);
    expect(report.totals.netTax).toBeCloseTo(48.8, 2);

    // And the liability the profit dashboard reports is the same money, before
    // the refund: the two views agree on what was collected.
    expect(d.salesTaxCollected).toBeCloseTo(report.totals.taxCollected - 8, 2);
  }, 60_000);

  it("reconciliation flags none of these orders — every total is internally consistent", async () => {
    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();
    expect(flags.filter((f) => f.type === "total_mismatch")).toEqual([]);
    expect(flags.filter((f) => f.type === "refund_exceeds_paid")).toEqual([]);
  }, 60_000);

  it("the whole ledger reconciles: revenue − COGS − fees − shipping = reported profit", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");
    const d = await getProfitDashboard(NOW);

    // Built from LEDGER independently of anything the modules computed.
    const counted = LEDGER.filter((o) => revenueStatuses.has(o.status) || o.status === "partially_refunded");
    let revenue = 0, cogs = 0, processing = 0, shipping = 0;
    for (const o of counted) {
      revenue += (o.subtotal - o.discount) + o.shipping + o.cardFee - Math.max(0, o.refund - o.tax);
      cogs += o.cogsCents / 100;
      processing += o.type === "replacement" ? 0 : (o.paid * CONFIG.processingFeePercent) / 100;
      shipping += o.type === "membership" ? 0 : CONFIG.shippingCostPerOrder;
    }
    const expectedProfit = Math.round((revenue - cogs - processing - shipping) * 100) / 100;

    expect(d.lifetime.netProfit).toBeCloseTo(expectedProfit, 2);
    // Pinned, so the assertion above cannot pass by both sides drifting
    // together, and so a change to any term shows up as a changed number here.
    expect(d.lifetime.netProfit).toBeCloseTo(484.52, 2);
    // Expenses really were deducted: profit is meaningfully below revenue.
    expect(d.lifetime.netProfit).toBeLessThan(d.lifetime.grossRevenue - 100);
  }, 60_000);
});
