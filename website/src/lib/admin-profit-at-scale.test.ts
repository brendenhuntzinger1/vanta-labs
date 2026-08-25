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
// THE PART THAT MATTERS MORE THAN SPEED. The orders fetch has no .range(), no
// .limit(), and no check that it received everything it asked for. If the row
// source ever returns fewer rows than exist — PostgREST applies a db-max-rows
// cap when one is configured, and Supabase exposes it as "Max rows" in the
// project's API settings — the dashboard does not fail, warn, or notice. It
// reports a smaller profit, confidently. The last test in this file
// demonstrates exactly that, and it is the reason to go and read that setting.
//
// I could not check the setting from here: this environment has no Supabase
// credentials, and the read-only SQL I do have shows no db-max-rows on any
// role, which only rules out a role-level override — not the PostgREST config
// itself. So this is written as an exposure, not as a confirmed defect, and no
// production code is changed for it.
// ---------------------------------------------------------------------------

const IN_CHUNK = 150;
const ORDERS_PER_DAY = 100;
const WINDOW_DAYS = 30;
const TOTAL_ORDERS = ORDERS_PER_DAY * WINDOW_DAYS;

/** Fixed clock: the code takes nowMs, so nothing here depends on the real one. */
const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const calls = { orders: 0, orderItems: 0, commissions: 0, overlay: 0 };

/** Set to a row count to simulate a source that silently truncates. */
let truncateOrdersAt: number | null = null;

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
            // The unbounded window read.
            gte() { return b; },
            lte() {
              calls.orders += 1;
              const rows = truncateOrdersAt === null ? orders : orders.slice(0, truncateOrdersAt);
              return envelope(rows);
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
  truncateOrdersAt = null;
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

    expect(calls.orders).toBe(1); // one unbounded window read
    expect(calls.orderItems).toBe(chunks);
    expect(calls.commissions).toBe(chunks);
    expect(calls.overlay).toBe(chunks);

    // 61 in total. Not per-order — an N+1 here would be 9,001.
    const total = calls.orders + calls.orderItems + calls.commissions + calls.overlay;
    expect(total).toBe(1 + chunks * 3);
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

describe("what a silent row cap would do to the dashboard", () => {
  /**
   * The exposure, made concrete. Nothing here asserts that a cap EXISTS — it
   * asserts what happens if the source ever returns short, which is that the
   * owner is shown a smaller profit with no indication anything was missing.
   */
  it("under-reports profit, silently, if the source returns short", async () => {
    const full = await getProfitWindowMetrics(NOW);

    truncateOrdersAt = 1000; // the common PostgREST db-max-rows default
    const capped = await getProfitWindowMetrics(NOW);

    expect(capped.ordersLast30Days).toBe(1000);
    expect(capped.last30Days).toBeLessThan(full.last30Days);
    // Two thirds of the month's profit is simply absent from the figure.
    expect(capped.last30Days / full.last30Days).toBeCloseTo(1 / 3, 2);
  });

  /**
   * And it says nothing about it. There is no flag on the returned object that
   * distinguishes "this is your profit" from "this is some of your profit" —
   * hasEstimatedCost covers missing COSTS, not missing ORDERS.
   */
  it("carries no signal that the figure is partial", async () => {
    truncateOrdersAt = 1000;
    const capped = await getProfitWindowMetrics(NOW);
    expect(Object.keys(capped)).toEqual([
      "today", "last7Days", "last30Days", "ordersLast30Days", "hasEstimatedCost",
    ]);
    expect(capped.hasEstimatedCost).toBe(false);
  });

  /**
   * At today's real volume — 8 orders in the store's entire history — no cap
   * can bite. This is a scale exposure, not a live fault, and that distinction
   * is why nothing was changed.
   */
  it("is unreachable at the store's current volume", async () => {
    orders.length = 8;
    truncateOrdersAt = 1000;
    const metrics = await getProfitWindowMetrics(NOW);
    expect(metrics.ordersLast30Days).toBe(8);
  });
});
