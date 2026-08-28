import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createPostgrestShim } from "@/lib/e2e/postgrest-shim";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// M-03 — AN ORDER THAT NEVER TOOK PAYMENT HAS NO REVENUE, NO COST AND NO PROFIT.
//
// `orders.amount_paid` is written when the order is CREATED, before anybody has
// paid: both checkout lanes write the final total at INSERT (payment-service,
// express/authorize), and so does every membership order. A row sitting at
// `pending_payment` therefore carries a full basket, a subtotal, a shipping
// charge and an amount_paid — and the profit engine, handed that row, happily
// computed revenue from it, charged a percentage processing fee against money
// nobody ever sent, deducted COGS for stock still on the shelf and postage for
// a parcel that was never packed.
//
// The dashboard never showed it (it filters on status), but the two per-order
// surfaces did not filter at all:
//
//   • the admin ORDER DETAIL profit panel
//   • the orders CSV EXPORT's profit columns
//
// So an abandoned checkout appeared in the owner's spreadsheet as a sale with a
// margin, and a cancelled order sat on its own page reporting a profit. Enough
// abandoned baskets and the export's profit column is fiction.
//
// The rule: profit is reported only for an order that CAPTURED money — which
// includes a fully refunded one (it took the money and gave it back, and its
// costs are real: VL-24) and excludes every state that never charged a card.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;

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
  customer_name text, order_type text not null default 'product', subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0, discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0, refund_amount numeric(12,2) not null default 0,
  card_processing_fee numeric(12,2) not null default 0, handling_fee numeric(12,2) not null default 0,
  shipping_protection_fee numeric(12,2) not null default 0,
  store_credit_redeemed_cents integer not null default 0, points_redeemed integer not null default 0,
  payment_method text, payment_status text not null, fulfillment_status text not null default 'awaiting_fulfillment',
  tracking_number text, referral_code text, coupon_code text,
  actual_shipping_cost_cents integer, shipping_cost_source text, profit_finalized boolean not null default false,
  paid_at timestamptz, created_at timestamptz not null);
create table order_items (id bigserial primary key, order_id text not null, quantity integer not null default 1, unit_cost_cents integer);
create table commissions (id bigserial primary key, order_id text not null, commission_amount numeric(12,2) not null default 0, status text not null default 'pending');
`;

// Every status this application writes to orders.payment_status, split by the
// one question that matters here: did a card ever get charged?
const CAPTURED = ["paid", "partially_refunded", "refunded"];
const NEVER_PAID = ["pending_payment", "awaiting_verification", "canceled", "payment_failed", "payment_rejected"];

let activeClient: Client;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return createPostgrestShim(activeClient, {}); },
}));
vi.mock("@/lib/admin-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-control")>()),
  getProfitSettings: async () => CONFIG,
}));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ role: "super_admin", username: "owner" }),
}));

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn("[unpaid-order-profit] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres.");
}

describeDb("profit is reported only for orders that took payment", () => {
  let client: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "unpaidprofit");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);

    let minute = 0;
    const seed = async (orderId: string, status: string, refund: number, type = "product") => {
      const at = new Date(Date.parse("2026-08-26T00:00:00.000Z") - ++minute * 60_000).toISOString();
      await client.query(
        `insert into orders (order_id, order_number, customer_email, customer_name, order_type,
           subtotal, shipping_amount, amount_paid, refund_amount, payment_method, payment_status, paid_at, created_at)
         values ($1,$1,'buyer@example.test','Buyer',$5,100,10,110,$2,'card',$3,$4,$4)`,
        [orderId, refund, status, at, type],
      );
      // Real stock cost on every row, so an order wrongly included cannot be
      // mistaken for one that simply had nothing to deduct.
      await client.query(`insert into order_items (order_id, quantity, unit_cost_cents) values ($1, 1, 3000)`, [orderId]);
    };

    for (const status of CAPTURED) await seed(`order-${status}`, status, status === "refunded" ? 110 : status === "partially_refunded" ? 40 : 0);
    for (const status of NEVER_PAID) await seed(`order-${status}`, status, 0);

    activeClient = client;
  }, 60_000);

  afterAll(async () => { await client?.end(); });

  it("reports nothing for an order that never charged a card", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");

    for (const status of NEVER_PAID) {
      // Before the fix each of these reported $110 of gross revenue, an $11
      // processing fee on money nobody sent, $30 of COGS for stock still on the
      // shelf and $6 of postage for a parcel that was never packed.
      expect(await getOrderProfit(`order-${status}`), status).toBeNull();
    }
  }, 60_000);

  it("still reports every order that did charge a card, refunds included", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");

    for (const status of CAPTURED) {
      const profit = await getOrderProfit(`order-${status}`);
      expect(profit, status).not.toBeNull();
      expect(profit!.cogs, status).toBeCloseTo(30, 2);
    }

    // And the refunded one is a LOSS, not a blank: revenue reversed, costs kept.
    const refunded = (await getOrderProfit("order-refunded"))!;
    expect(refunded.revenue).toBeCloseTo(0, 2);
    expect(refunded.profit).toBeCloseTo(-47, 2);
  }, 60_000);

  it("leaves unpaid orders out of the batch the CSV export reads", async () => {
    const { getOrderProfitMap } = await import("@/lib/admin-profit");
    const ids = [...CAPTURED, ...NEVER_PAID].map((status) => `order-${status}`);

    const map = await getOrderProfitMap(ids);

    expect([...map.keys()].sort()).toEqual(CAPTURED.map((s) => `order-${s}`).sort());
  }, 60_000);

  it("exports blank profit columns for an unpaid order, and real ones for a paid order", async () => {
    const { GET } = await import("@/app/api/admin/orders/export/route");
    const response = await GET(new Request("https://vanta.test/api/admin/orders/export"));
    const csv = await response.text();

    const [header, ...lines] = csv.trim().split("\n");
    const columns = header.split(",");
    const netProfit = columns.indexOf("net_profit");
    const grossRevenue = columns.indexOf("gross_revenue");
    const productCost = columns.indexOf("product_cost");
    expect(netProfit).toBeGreaterThan(-1);

    const rowFor = (orderId: string) => lines.find((line) => line.startsWith(`${orderId},`))!.split(",");

    const paid = rowFor("order-paid");
    expect(paid[grossRevenue]).toBe("110");
    expect(paid[netProfit]).toBe("63");

    for (const status of NEVER_PAID) {
      const row = rowFor(`order-${status}`);
      // The row is still exported — the order exists and the operator needs to
      // see it. Its PROFIT columns are empty, because there is no profit.
      expect(row[grossRevenue], status).toBe("");
      expect(row[productCost], status).toBe("");
      expect(row[netProfit], status).toBe("");
    }
  }, 60_000);
});
