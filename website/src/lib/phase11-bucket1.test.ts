import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 11 — the admin money surfaces.
//
// Four defects, all of the same family: a report that is quietly incomplete, or
// two reports that answer the same question differently and say they don't.
//
//   M-16    the revenue windows were the last financial reads not paged, so
//           PostgREST's db-max-rows silently capped the "Revenue · 30d" tile.
//   F-A-13  the shipping-overlay read treated EVERY error as "the migration has
//           not run", which substitutes the $6 estimate and overstates profit.
//   SOT-06  a second refunded-tax rule lived in admin-profit and disagreed with
//           the filing report's one, while its comment claimed to mirror it.
//   ADM-10  the dashboard's order table advertised pending orders that its own
//           query removes.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

type Row = Record<string, unknown>;

const db = {
  orders: [] as Row[],
  orderItems: [] as Row[],
  commissions: [] as Row[],
  overlays: [] as Row[],
  /** Models PostgREST's db-max-rows: a cap on ONE response, not on what exists. */
  maxRowsPerResponse: null as number | null,
  overlayError: null as null | { code?: string; message?: string },
};

function cap(rows: Row[]) {
  return db.maxRowsPerResponse === null ? rows : rows.slice(0, db.maxRowsPerResponse);
}

/** Enough PostgREST to filter, page, and fail. */
function builder(rows: Row[], error: unknown = null) {
  let working = [...rows];
  const b: Record<string, unknown> = {
    eq(column: string, value: unknown) { working = working.filter((r) => String(r[column]) === String(value)); return b; },
    in(column: string, values: unknown[]) {
      const wanted = new Set(values.map(String));
      working = working.filter((r) => wanted.has(String(r[column])));
      return b;
    },
    is(column: string, value: unknown) { if (value === null) working = working.filter((r) => r[column] == null); return b; },
    gte(column: string, value: unknown) { working = working.filter((r) => r[column] != null && String(r[column]) >= String(value)); return b; },
    lte(column: string, value: unknown) { working = working.filter((r) => r[column] != null && String(r[column]) <= String(value)); return b; },
    not() { return b; },
    order() { return b; },
    limit() { return b; },
    range: async (from: number, to: number) => ({ data: cap(working.slice(from, to + 1)), error }),
    maybeSingle: async () => ({ data: working[0] ?? null, error }),
    then: (resolve_: (v: unknown) => unknown) =>
      Promise.resolve({ data: error ? null : cap(working), error }).then(resolve_),
  };
  return b;
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    processingFeePercent: 0,
    processingFeeIncludesTax: false,
    countSalesTaxAsProfit: false,
    shippingCostPerOrder: 6,
    worstCaseUnitCost: 0,
  }),
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (columns: string) => {
        if (table === "order_items") return builder(db.orderItems);
        if (table === "commissions") return builder(db.commissions);
        if (table === "orders") {
          // The overlay read is the one that asks for the reconciliation columns.
          if (columns.includes("actual_shipping_cost_cents")) return builder(db.overlays, db.overlayError);
          return builder(db.orders);
        }
        return builder([]);
      },
    }),
  },
}));

const { getRevenueWindowMetrics } = await import("@/lib/admin-analytics");
const { getOrderProfit } = await import("@/lib/admin-profit");
const { refundedTaxFor } = await import("@/lib/admin-tax-report");

const PROFIT_ORDER = {
  order_id: "ord-1",
  order_number: "VL-1",
  order_type: "product",
  subtotal: 100,
  discount_amount: 0,
  shipping_amount: 0,
  handling_fee: 0,
  tax_amount: 0,
  refund_amount: 0,
  amount_paid: 100,
  payment_method: "card",
  payment_status: "paid",
  paid_at: "2026-08-20T12:00:00.000Z",
  created_at: "2026-08-20T12:00:00.000Z",
  shipping_protection_fee: 0,
  card_processing_fee: 0,
  store_credit_redeemed_cents: 0,
  points_redeemed: 0,
};

beforeEach(() => {
  db.orders = [];
  db.orderItems = [];
  db.commissions = [];
  db.overlays = [];
  db.maxRowsPerResponse = null;
  db.overlayError = null;
});

// ---------------------------------------------------------------------------
// M-16 — the revenue tile under a row cap.
// ---------------------------------------------------------------------------
describe("the 30-day revenue window survives a capped row source", () => {
  const ORDERS = 2_500;
  const PER_ORDER = 10;

  beforeEach(() => {
    const paidAt = new Date(Date.now() - 60_000).toISOString();
    db.orders = Array.from({ length: ORDERS }, (_, n) => ({
      id: n + 1,
      order_id: `ord-${n}`,
      amount_paid: PER_ORDER,
      refund_amount: 0,
      payment_status: "paid",
      order_type: "product",
      paid_at: paidAt,
      created_at: paidAt,
    }));
  });

  it("reports every order's revenue when a response caps at 1,000 rows", async () => {
    db.maxRowsPerResponse = 1000; // the common PostgREST db-max-rows default
    const metrics = await getRevenueWindowMetrics();

    // Unpaged, this read came back with the first 1,000 rows and reported
    // $10,000 as the store's 30-day revenue, with no error and no warning.
    expect(metrics.last30Days).toBeCloseTo(ORDERS * PER_ORDER, 2);
    expect(metrics.truncated).toBe(false);
  });

  it("survives a cap that is not a multiple of the page size", async () => {
    db.maxRowsPerResponse = 337;
    const metrics = await getRevenueWindowMetrics();

    expect(metrics.last30Days).toBeCloseTo(ORDERS * PER_ORDER, 2);
  });
});

// ---------------------------------------------------------------------------
// F-A-13 — a failed overlay read is not "the migration has not run".
// ---------------------------------------------------------------------------
describe("the shipping-overlay read separates a missing column from a failure", () => {
  beforeEach(() => {
    db.orders = [PROFIT_ORDER];
    db.orderItems = [{ order_id: PROFIT_ORDER.order_id, quantity: 1, unit_cost_cents: 4000 }];
    db.overlays = [{
      order_id: PROFIT_ORDER.order_id,
      actual_shipping_cost_cents: 900,
      shipping_cost_source: "shippo",
      profit_finalized: true,
    }];
  });

  it("uses the exact label cost when the overlay reads cleanly", async () => {
    const profit = await getOrderProfit(PROFIT_ORDER.order_id);
    expect(profit?.shippingCost).toBe(9);
    expect(profit?.profit).toBe(51); // 100 − 40 COGS − 9 shipping
  });

  it("falls back to the estimate only for an undefined column (42703)", async () => {
    db.overlayError = { code: "42703", message: "column orders.actual_shipping_cost_cents does not exist" };
    const profit = await getOrderProfit(PROFIT_ORDER.order_id);

    expect(profit?.shippingCost).toBe(6); // config.shippingCostPerOrder
    expect(profit?.shippingCostIsEstimate).toBe(true);
  });

  // THE DIRECTION THAT MATTERS. Swallowing this substituted the $6 estimate for
  // a $9 label, so profit came out $3 BETTER than the truth on every order in
  // the failing chunk — the comment above the commission read claimed the
  // overlay could only make profit look worse.
  it("refuses to report a profit figure when the read fails for any other reason", async () => {
    db.overlayError = { code: "57014", message: "canceling statement due to statement timeout" };

    await expect(getOrderProfit(PROFIT_ORDER.order_id)).rejects.toThrow(/shipping overlay read failed/i);
    await expect(getOrderProfit(PROFIT_ORDER.order_id)).rejects.toThrow(/statement timeout/i);
  });
});

// ---------------------------------------------------------------------------
// SOT-06 / F-TAX-07 / DUP-02 — one rule for the tax that came back.
//
// The two implementations produced the same profit figure today (with
// refund_amount 0 the engine clamps the difference away), so this cannot be
// reached from a unit test on the output. It is asserted against the source,
// the way handoff-invariants.test.ts asserts seams that no unit test spans.
// ---------------------------------------------------------------------------
describe("the profit report and the filing report share one refunded-tax rule", () => {
  const profitSource = source("src/lib/admin-profit.ts");

  it("keeps only the filing report's implementation", () => {
    expect(profitSource).not.toContain("refundedTaxPortion");
    expect(profitSource).toContain('import { refundedTaxFor } from "@/lib/admin-tax-report"');
    expect(profitSource).toContain("refundedTax: refundedTaxFor(order),");
  });

  // The one input the two answered differently: a row marked refunded that
  // predates the refund_amount column. The filing report trusts the status.
  it("treats a legacy refunded row with no refund_amount as fully refunded tax", () => {
    expect(refundedTaxFor({ tax_amount: 6, amount_paid: 100, refund_amount: 0, payment_status: "refunded" })).toBe(6);
    expect(refundedTaxFor({ tax_amount: 6, amount_paid: 100, refund_amount: 0, payment_status: "paid" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ADM-10 + F-A-2 — captions that match the query, and a ceiling that is shown.
// ---------------------------------------------------------------------------
describe("the admin dashboard describes the rows it actually shows", () => {
  const home = source("src/app/admin/page.tsx");
  const revenue = source("src/app/admin/revenue/page.tsx");

  it("does not promise pending orders that paymentStatus:\"active\" removes", () => {
    // admin-orders.ts excludes pending_payment / canceled for the "active"
    // filter, so the old caption named rows this table can never contain.
    expect(home).toContain('paymentStatus: "active"');
    expect(home).not.toContain("Latest paid and pending orders");
  });

  it("renders the truncation flag every report already returns", () => {
    expect(home).toContain("profitWindows.truncated");
    expect(home).toContain("revenueWindows.truncated");
    expect(home).toContain("profitDashboard?.truncated");
    expect(revenue).toContain("taxReport?.truncated");
    // A fallback that omits the flag would claim a complete report on the very
    // path where the read failed.
    expect(home).not.toMatch(/hasEstimatedCost: false \}\)\)/);
  });
});
