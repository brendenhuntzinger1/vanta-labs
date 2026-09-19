import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { createPostgrestShim } from "@/lib/e2e/postgrest-shim";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";
import { countsInFinancials, isSaleOrder, isTestOrder, NON_SALE_ORDER_TYPES } from "@/lib/ledger";
import { isShippableOrderType, NON_SHIPPABLE_ORDER_TYPES, NON_SHIPPABLE_ORDER_TYPES_FILTER } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// A TEST ORDER IS NOT IN THE BOOKS, AND IT DOES NOT GET PACKED.
//
// `order_type = 'test'` existed before this file and did exactly one thing:
// render an amber badge in the admin orders list. admin-orders.ts said so in as
// many words — "THIS IS A LABEL, NOT A LEDGER RULE" — and `NON_SALE_ORDER_TYPES`
// deliberately left it out, so a test order:
//
//   • counted as revenue on /admin/revenue, in the analytics windows and trend,
//     in the campaign report, and in the partner portal's live-sales tile
//   • carried a COGS, a postage estimate and a processor fee into the profit
//     dashboard, so the store's net profit got WORSE the more it tested itself
//   • made the owner a "returning customer" in the repeat-purchase tile
//   • sat in the packing queue waiting to be shipped
//
// The last one is the dangerous one. Retiring a test order returns its stock to
// the shelf (inventory_restocked_at), so an order left in the queue is a pick
// list for a unit the inventory count says is still there. Packing it oversells
// by one, and nothing notices until someone reconciles.
//
// VL-594E0EAB is the order that surfaced all of it: a $3.00 card charge against
// an 80% coupon, placed on production to check purchase-conversion tracking. It
// reported as $3.00 of revenue and sat in `awaiting_fulfillment` with its Recon
// water already back in stock.
//
// THE TWO RULES ARE SEPARATE AND BOTH ARE NEEDED, which is the thing this file
// exists to hold:
//
//   ledger.NON_SALE_ORDER_TYPES        what is not revenue     replacement, test
//   ledger.countsInFinancials          what is not in the      test only
//                                      profit report at all
//   pipeline.NON_SHIPPABLE_ORDER_TYPES what never ships        membership, test
//
// No single set answers all three. A replacement is not revenue but its costs
// are real, so it stays in the profit report. A membership is revenue but never
// ships. Only a test order is absent from every one of them.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

describe("the predicates themselves", () => {
  it("treats a test order as neither a sale nor something with a line in the books", () => {
    expect(isTestOrder("test")).toBe(true);
    expect(isSaleOrder("test")).toBe(false);
    expect(countsInFinancials("test")).toBe(false);
  });

  it("keeps a replacement's COSTS in the books even though it is not a sale", () => {
    // The distinction `isSaleOrder` alone cannot make, and the reason
    // countsInFinancials had to exist. admin-profit counts a reship's row on
    // purpose: "the merchandise and the postage were really spent". Folding
    // 'test' into isSaleOrder and stopping there would have left the test
    // order's costs in the total.
    expect(isSaleOrder("replacement")).toBe(false);
    expect(countsInFinancials("replacement")).toBe(true);
  });

  it("leaves an ordinary product order and a membership alone", () => {
    for (const orderType of ["product", null, undefined, "membership"]) {
      expect(isSaleOrder(orderType), String(orderType)).toBe(true);
      expect(countsInFinancials(orderType), String(orderType)).toBe(true);
    }
  });

  it("is case-insensitive, because order_type is free text with no check constraint", () => {
    expect(isTestOrder("TEST")).toBe(true);
    expect(isSaleOrder("Test")).toBe(false);
  });

  it("never ships a test order or a membership, and always ships a product", () => {
    expect(isShippableOrderType("test")).toBe(false);
    expect(isShippableOrderType("membership")).toBe(false);
    expect(isShippableOrderType("product")).toBe(true);
    expect(isShippableOrderType(null)).toBe(true);
  });

  it("derives the PostgREST filter from the set rather than restating it", () => {
    // The seven hand-written `.neq("order_type", "membership")` call sites this
    // replaced are the reason. A literal here would be the same rule written
    // twice, and the second copy is the one that gets forgotten.
    for (const orderType of NON_SHIPPABLE_ORDER_TYPES) {
      expect(NON_SHIPPABLE_ORDER_TYPES_FILTER).toContain(orderType);
    }
    expect(NON_SHIPPABLE_ORDER_TYPES_FILTER).toBe(`(${[...NON_SHIPPABLE_ORDER_TYPES].join(",")})`);
  });
});

// ---------------------------------------------------------------------------
// The SQL half. The rollups aggregate in Postgres and the app falls back to JS
// when a function is absent, so the two must exclude the same order types or
// /admin/revenue means something different depending on whether the migration
// happens to have been run — the failure admin-dashboard-rollups.sql's own
// DEPLOYMENT ORDER NOTE was written about.
// ---------------------------------------------------------------------------

const SQL_DIR = path.resolve(__dirname, "sql");

/** Strip SQL comments so prose ABOUT the rule is not mistaken for the rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function shippedSql(): Array<{ name: string; source: string }> {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, source: stripComments(readFileSync(path.join(SQL_DIR, name), "utf8")) }));
}

describe("the SQL agrees with the ledger about what is not a sale", () => {
  it("excludes every NON_SALE_ORDER_TYPE wherever it excludes any of them", () => {
    // Matches the shape the rollups use: `coalesce(order_type, 'product') <op> …`.
    // Asserting on the shape rather than on a file list means a NEW migration
    // that copies the old one-type predicate fails here, which is exactly how
    // the gross-revenue definition came to exist in two files at once.
    const predicate = /coalesce\(\s*order_type\s*,\s*'product'\s*\)\s*(?:<>|!=|not\s+in)\s*\(?([^)\n]*)\)?/gi;
    let checked = 0;

    for (const { name, source } of shippedSql()) {
      for (const match of source.matchAll(predicate)) {
        const listed = new Set(
          match[1].split(",").map((part) => part.trim().replace(/^'|'$/g, "").toLowerCase()).filter(Boolean),
        );
        for (const orderType of NON_SALE_ORDER_TYPES) {
          expect(
            listed.has(orderType),
            `${name}: "${match[0].trim()}" does not exclude '${orderType}'`,
          ).toBe(true);
        }
        checked += 1;
      }
    }

    // Guards against the assertion passing vacuously if the SQL is restructured
    // so the pattern stops matching.
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("keeps the fulfillment count index usable by the query that needs it", () => {
    // A partial index is only usable when the query IMPLIES its predicate. The
    // moment getBucketCounts started excluding 'test' as well, an index whose
    // WHERE still said "not membership" stopped matching and every admin page
    // load fell back to a sequential scan — silent, and worse the bigger the
    // store gets.
    const source = readFileSync(path.join(SQL_DIR, "fulfillment-batches.sql"), "utf8");
    const match = /idx_orders_fulfillment_counts[\s\S]*?order_type\s+not\s+in\s*\(([^)]*)\)/i.exec(source);
    expect(match, "idx_orders_fulfillment_counts no longer has an order_type predicate").not.toBeNull();

    const listed = new Set(
      match![1].split(",").map((part) => part.trim().replace(/^'|'$/g, "").toLowerCase()).filter(Boolean),
    );
    expect(listed).toEqual(new Set(NON_SHIPPABLE_ORDER_TYPES));
  });
});

// ---------------------------------------------------------------------------
// The engines, against a real Postgres. A predicate agreeing with itself in
// TypeScript proves nothing about what the profit dashboard and the packing
// queue actually return.
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
  tracking_number text, shipping_carrier text, label_url text, shippo_transaction_id text,
  shippo_sync_status text, shippo_sync_error text, label_purchase_claimed_at timestamptz,
  label_purchased_at timestamptz, shipped_at timestamptz, updated_at timestamptz,
  priority boolean not null default false,
  city text, state text, country text,
  referral_code text, coupon_code text,
  actual_shipping_cost_cents integer, shipping_cost_source text, profit_finalized boolean not null default false,
  paid_at timestamptz, created_at timestamptz not null);
create table order_items (id bigserial primary key, order_id text not null, quantity integer not null default 1, unit_cost_cents integer);
create table commissions (id bigserial primary key, order_id text not null, commission_amount numeric(12,2) not null default 0, status text not null default 'pending');
`;

let activeClient: Client;
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return createPostgrestShim(activeClient, {}); },
}));
vi.mock("@/lib/admin-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-control")>()),
  getProfitSettings: async () => CONFIG,
}));

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn("[test-order-is-not-in-the-books] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres.");
}

describeDb("a test order against the real engines", () => {
  let client: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "testorderbooks");
    client = new Client({ connectionString: suiteUrl });
    await client.connect();
    await client.query(SCHEMA);

    // Two orders, identical in every respect except order_type. Anything that
    // differs between them is attributable to the type and nothing else.
    const seed = async (orderId: string, orderType: string) => {
      await client.query(
        `insert into orders (order_id, order_number, customer_email, customer_name, order_type,
           subtotal, shipping_amount, amount_paid, payment_method, payment_status, fulfillment_status,
           paid_at, created_at, updated_at)
         values ($1,$1,'owner@vantalabs.test','Owner',$2,100,10,110,'card','paid','ready_to_fulfill',
           '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z','2026-09-19T00:00:00Z')`,
        [orderId, orderType],
      );
      // Real stock cost on both, so an order wrongly included cannot be mistaken
      // for one that simply had nothing to deduct.
      await client.query(`insert into order_items (order_id, quantity, unit_cost_cents) values ($1, 1, 3000)`, [orderId]);
    };

    await seed("order-real", "product");
    await seed("order-test", "test");

    activeClient = client;
  }, 60_000);

  afterAll(async () => { await client?.end(); });

  it("reports no profit for it, while the identical product order reports plenty", async () => {
    const { getOrderProfit } = await import("@/lib/admin-profit");

    // Before this change the test order reported $110 of revenue, $30 of COGS
    // for stock that went back on the shelf, $6 of postage for a parcel nobody
    // posted and an $11 processing fee — a complete set of books for a sale the
    // store made to itself.
    expect(await getOrderProfit("order-test")).toBeNull();

    const real = await getOrderProfit("order-real");
    expect(real).not.toBeNull();
    expect(real!.cogs).toBeCloseTo(30, 2);
  }, 60_000);

  it("leaves it out of the batch the CSV export and the dashboard read", async () => {
    const { getOrderProfitMap } = await import("@/lib/admin-profit");

    const map = await getOrderProfitMap(["order-real", "order-test"]);

    expect([...map.keys()]).toEqual(["order-real"]);
  }, 60_000);

  it("contributes nothing to net profit or the order count on the dashboard", async () => {
    const { getProfitDashboard } = await import("@/lib/admin-profit");

    const dashboard = await getProfitDashboard();

    // One order in the store's books, not two — and the test order is not
    // hiding inside the totals as a small loss either. It is also not counted as
    // a replacement: `replacementCount` is the bucket every non-sale used to
    // fall into, and a test order belongs in neither column.
    expect(dashboard.lifetime.orderCount).toBe(1);
    expect(dashboard.lifetime.replacementCount).toBe(0);
    expect(dashboard.lifetime.grossRevenue).toBeCloseTo(110, 2);
    // 110 revenue - 30 COGS - 6 postage - 11 fee. One order's worth, not two.
    expect(dashboard.lifetime.netProfit).toBeCloseTo(63, 2);
  }, 60_000);

  it("is not offered to be packed", async () => {
    const { getBucketOrders } = await import("@/lib/fulfillment-queues");

    // "ready" is the bucket id; "Needs Fulfillment" is what the owner reads.
    const queue = await getBucketOrders("ready");

    // The one that matters most: the test order's stock has already been
    // returned, so packing it would oversell by one.
    expect(queue.map((order) => order.orderId)).toEqual(["order-real"]);
  }, 60_000);

  it("is not counted on the work board", async () => {
    const { getBucketCounts } = await import("@/lib/fulfillment-queues");

    const board = await getBucketCounts();
    const readyToFulfill = board.counts.find((bucket) => bucket.id === "ready");

    expect(readyToFulfill?.count).toBe(1);
  }, 60_000);
});
