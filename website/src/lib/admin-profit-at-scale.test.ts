import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PROFIT NUMBER AT A HUNDRED ORDERS A DAY.
//
// getProfitWindowMetrics is the headline figure on the admin dashboard. It
// reads EVERY order in the last thirty days in one unbounded select, then
// fetches cost lines, commissions and shipping overlays for all of them in
// chunks of 150.
//
// The store has 8 orders today, so nothing has ever exercised this at volume.
// At a hundred orders a day it is 3,000 orders and about sixty round trips per
// dashboard load. That is worth knowing before it happens rather than after.
//
// THE PART THAT MATTERED MORE THAN SPEED, AND HAS SINCE BEEN FIXED. The orders
// fetch had no .range(), no .limit(), and no check that it received everything
// it asked for. If the row source returned fewer rows than existed — PostgREST
// applies a db-max-rows cap when one is configured, and Supabase exposes it as
// "Max rows" in the project's API settings — the dashboard did not fail, warn,
// or notice. It reported a smaller profit, confidently.
//
// The setting still cannot be read from this environment. Block F stopped
// trying: the read now pages until the source returns nothing, so the value of
// that setting no longer changes any reported number. The last describe block
// holds the tests that used to record the exposure and now hold the defence.
// ---------------------------------------------------------------------------

const IN_CHUNK = 150;
const ORDERS_PER_DAY = 100;
const WINDOW_DAYS = 30;
const TOTAL_ORDERS = ORDERS_PER_DAY * WINDOW_DAYS;

/** Fixed clock: the code takes nowMs, so nothing here depends on the real one. */
const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const calls = { orders: 0, orderItems: 0, commissions: 0, overlay: 0 };

/**
 * Models PostgREST's `db-max-rows`: a cap on how many rows a SINGLE response
 * may carry, not on how many exist. That distinction is the whole point — a
 * reader that pages can recover everything from a capped source, and a reader
 * that fires one unbounded select cannot.
 */
let sourceMaxRowsPerResponse: number | null = null;

interface FakeOrder {
  order_id: string;
  order_number: string;
  order_type: string;
  subtotal: number;
  discount_amount: number;
  shipping_amount: number;
  tax_amount: number;
  refund_amount: number;
  amount_paid: number;
  payment_method: string;
  payment_status: string;
  paid_at: string;
  created_at: string;
  shipping_protection_fee: number;
  card_processing_fee: number;
  store_credit_redeemed_cents: number;
  points_redeemed: number;
}

const orders: FakeOrder[] = [];

/** One order per slot, spread evenly across the window. $100 merchandise. */
function buildOrders() {
  orders.length = 0;
  for (let day = 0; day < WINDOW_DAYS; day += 1) {
    for (let n = 0; n < ORDERS_PER_DAY; n += 1) {
      const at = new Date(NOW - day * DAY - n * 60_000).toISOString();
      orders.push({
        order_id: `ord-${day}-${n}`,
        order_number: `VL-${day}${n}`,
        order_type: "product",
        subtotal: 100,
        discount_amount: 0,
        shipping_amount: 15,
        tax_amount: 0,
        refund_amount: 0,
        amount_paid: 115,
        payment_method: "card",
        payment_status: "paid",
        paid_at: at,
        created_at: at,
        shipping_protection_fee: 0,
        card_processing_fee: 0,
        store_credit_redeemed_cents: 0,
        points_redeemed: 0,
      });
    }
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    processingFeePercent: 8,
    defaultShippingCostCents: 0,
    handlingCostCents: 0,
    defaultUnitCostCents: 0,
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  /** Resolves like a PostgREST builder once awaited. */
  function envelope(rows: unknown[]) {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      gte() { return b; },
      lte() { return b; },
      in(_column: string, values: unknown[]) { (b as { _ids?: unknown[] })._ids = values; return b; },
      order() { return b; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data: rows, error: null })); },
    };
    return b;
  }

  const from = (table: string) => {
    if (table === "order_items") {
      return {
        select: () => ({
          in(_c: string, ids: string[]) {
            calls.orderItems += 1;
            // $40 unit cost on a $100 order.
            return envelope(ids.map((id) => ({ order_id: id, quantity: 1, unit_cost_cents: 4000 })));
          },
        }),
      };
    }
    if (table === "commissions") {
      return {
        select: () => ({
          in(_c: string, _ids: string[]) { calls.commissions += 1; return envelope([]); },
        }),
      };
    }
    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            // The chunked overlay read.
            in(_c: string, ids: string[]) {
              calls.overlay += 1;
              return envelope(ids.map((id) => ({
                order_id: id,
                actual_shipping_cost_cents: 900,
                shipping_cost_source: "shippo",
                profit_finalized: true,
              })));
            },
            // The paged window read.
            gte() { return b; },
            lte() { return b; },
            order() { return b; },
            range(from: number, to: number) {
              calls.orders += 1;
              const wanted = orders.slice(from, to + 1);
              const capped = sourceMaxRowsPerResponse === null ? wanted : wanted.slice(0, sourceMaxRowsPerResponse);
              return envelope(capped);
            },
          };
          return b;
        },
      };
    }
    return { select: () => envelope([]) };
  };
  return { supabaseAdmin: { from } };
});

const { getProfitWindowMetrics } = await import("@/lib/admin-profit");

beforeEach(() => {
  buildOrders();
  calls.orders = 0;
  calls.orderItems = 0;
  calls.commissions = 0;
  calls.overlay = 0;
  sourceMaxRowsPerResponse = null;
});

describe("3,000 orders in the window", () => {
  it("counts every one of them", async () => {
    const metrics = await getProfitWindowMetrics(NOW);
    expect(metrics.ordersLast30Days).toBe(TOTAL_ORDERS);
  });

  it("gets the money right, to the cent", async () => {
    const metrics = await getProfitWindowMetrics(NOW);

    // Per order: $100 merch + $15 shipping collected = $115 revenue ex-tax.
    //   cost $40, processing 8% of $115 = $9.20, actual shipping $9.00.
    //   profit = 115 - 40 - 9.20 - 9 = $56.80
    const PER_ORDER = 56.8;

    // Counted from the fixture against the same boundaries the code uses,
    // rather than assumed. The windows are inclusive (>=), so the order sitting
    // exactly on the seven-day edge belongs inside it — hardcoding 7 x 100 here
    // was wrong by exactly one order, and asserting a guessed number would have
    // meant loosening the tolerance until a real error could hide too.
    const dayStart = Date.parse(new Date(NOW).toISOString().slice(0, 10) + "T00:00:00.000Z");
    const inWindow = (since: number) =>
      orders.filter((order) => Date.parse(order.paid_at) >= since).length;

    expect(metrics.last30Days).toBeCloseTo(PER_ORDER * inWindow(NOW - 30 * DAY), 2);
    expect(metrics.last7Days).toBeCloseTo(PER_ORDER * inWindow(NOW - 7 * DAY), 2);
    expect(metrics.today).toBeCloseTo(PER_ORDER * inWindow(dayStart), 2);

    // And the window really does contain everything built.
    expect(inWindow(NOW - 30 * DAY)).toBe(TOTAL_ORDERS);
  });

  it("makes the number of round trips the chunk size implies, and no more", async () => {
    await getProfitWindowMetrics(NOW);
    const chunks = Math.ceil(TOTAL_ORDERS / IN_CHUNK); // 20
    // Three full pages of 1,000, then one empty page that ends the read. That
    // last request is the price of never guessing whether a source is finished:
    // stopping on a short page instead would mis-handle a capped source.
    const orderPages = Math.ceil(TOTAL_ORDERS / 1000) + 1; // 4

    expect(calls.orders).toBe(orderPages);
    expect(calls.orderItems).toBe(chunks);
    expect(calls.commissions).toBe(chunks);
    expect(calls.overlay).toBe(chunks);

    // 64 in total. Not per-order — an N+1 here would be 9,001.
    const total = calls.orders + calls.orderItems + calls.commissions + calls.overlay;
    expect(total).toBe(orderPages + chunks * 3);
    expect(total).toBeLessThan(100);
  });

  it("stays well inside a request budget", async () => {
    const started = performance.now();
    await getProfitWindowMetrics(NOW);
    // Pure aggregation over 3,000 orders, with the network stubbed out. This
    // bounds the CPU cost only; it says nothing about database latency.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("a silent row cap on the source", () => {
  /**
   * THE EXPOSURE THIS FILE WAS WRITTEN FOR, NOW CLOSED.
   *
   * It used to record that a short read produced a smaller profit with no
   * indication anything was missing, and deliberately changed no production
   * code: at eight orders the cap could not bite, and the setting could not be
   * read from this environment.
   *
   * Block F reproduced it at 21,000 orders against a real Postgres
   * (financial-reporting-row-caps.test.ts) and fixed the read instead of
   * measuring the setting. profitForPaidOrdersInRange pages until the source
   * returns nothing, advancing by the rows it actually received, so a cap now
   * costs round trips rather than accuracy — and the project's "Max rows"
   * value stops being something the profit figure depends on.
   */
  it("no longer changes the profit figure", async () => {
    const full = await getProfitWindowMetrics(NOW);

    sourceMaxRowsPerResponse = 1000; // the common PostgREST db-max-rows default
    const capped = await getProfitWindowMetrics(NOW);

    expect(capped.ordersLast30Days).toBe(TOTAL_ORDERS);
    expect(capped.ordersLast30Days).toBe(full.ordersLast30Days);
    expect(capped.last30Days).toBeCloseTo(full.last30Days, 2);
  });

  /**
   * A cap that is not a multiple of the page size makes every response arrive
   * short of what was asked for. A reader that treats "short" as "finished"
   * stops on the first page; this one stops only on an empty one.
   */
  it("survives a cap that is not a multiple of the page size", async () => {
    const full = await getProfitWindowMetrics(NOW);

    sourceMaxRowsPerResponse = 337;
    calls.orders = 0; // count only the capped run's page requests
    const capped = await getProfitWindowMetrics(NOW);

    expect(capped.ordersLast30Days).toBe(full.ordersLast30Days);
    expect(capped.last30Days).toBeCloseTo(full.last30Days, 2);
    // It costs requests, and that is the whole cost.
    expect(calls.orders).toBe(Math.ceil(TOTAL_ORDERS / 337) + 1);
  });

  it("still reports the truth at the store's current volume", async () => {
    orders.length = 8;
    sourceMaxRowsPerResponse = 1000;
    const metrics = await getProfitWindowMetrics(NOW);
    expect(metrics.ordersLast30Days).toBe(8);
  });
});
