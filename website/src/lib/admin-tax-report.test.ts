import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK F — what the sales-tax filing report does with a refund.
//
// This report is not a dashboard. Its output is the number the owner writes on
// a state return, so being wrong here is a filing error, not a display bug.
//
// Two defects lived in the refund handling:
//
//   1. A PARTIALLY REFUNDED ORDER VANISHED. `partially_refunded` is not in
//      PAID_ORDER_STATUSES and is not the string "refunded", so it failed both
//      halves of the paid/refunded test and hit `continue`. The customer kept
//      the goods and the state kept the tax, and the order was not on the
//      return at all.
//
//   2. A FULL REFUND WAS COUNTED ONCE, AS A DEDUCTION ONLY. The refunded order
//      never contributed to taxCollected, but its whole tax went into
//      taxRefunded — so netTax = collected − refunded came out one full tax
//      amount too low, and a state whose only taxed order was refunded reported
//      a NEGATIVE amount due.
// ---------------------------------------------------------------------------

interface FakeOrder {
  order_number: string;
  created_at: string;
  state: string | null;
  tax_state: string | null;
  tax_amount: number;
  tax_rate_percent: number;
  subtotal: number;
  discount_amount: number;
  amount_paid: number;
  refund_amount: number;
  payment_status: string;
}

let table: FakeOrder[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    const rows = () => table.filter((o) => o.tax_amount > 0);
    let from = 0;
    let to = Number.MAX_SAFE_INTEGER;
    const api = {
      gt: () => api,
      gte: () => api,
      lt: () => api,
      order: () => api,
      range: (a: number, b: number) => { from = a; to = b; return api; },
      then: (resolve: (v: { data: FakeOrder[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: rows().slice(from, to + 1), error: null })),
    };
    return api;
  };
  return { supabaseAdmin: { from: () => ({ select: () => builder() }) } };
});

const order = (over: Partial<FakeOrder> & { order_number: string }): FakeOrder => ({
  created_at: "2026-08-01T00:00:00.000Z",
  state: "California",
  tax_state: "CA",
  tax_amount: 8,
  tax_rate_percent: 8,
  subtotal: 100,
  discount_amount: 0,
  amount_paid: 108,
  refund_amount: 0,
  payment_status: "paid",
  ...over,
});

describe("sales-tax report — refunds", () => {
  beforeEach(() => { table = []; });

  it("counts a partially refunded order, which used to disappear entirely", async () => {
    table = [order({ order_number: "VL-1", payment_status: "partially_refunded", refund_amount: 54 })];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.rows).toHaveLength(1);
    expect(report.totals.taxCollected).toBe(8);
    // Half the money came back, so half the tax did: 8 × 54/108.
    expect(report.totals.taxRefunded).toBe(4);
    expect(report.totals.netTax).toBe(4);
  });

  it("a fully refunded order nets to zero, not to minus its own tax", async () => {
    table = [order({ order_number: "VL-2", payment_status: "refunded", refund_amount: 108 })];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.totals.taxCollected).toBe(8);
    expect(report.totals.taxRefunded).toBe(8);
    // Was −8: the collection was never recorded, only the refund.
    expect(report.totals.netTax).toBe(0);
    expect(report.byState[0].netTax).toBe(0);
  });

  it("a state whose only taxed order was refunded never reports negative tax due", async () => {
    table = [
      order({ order_number: "VL-3", tax_state: "TX", state: "Texas", payment_status: "refunded", refund_amount: 108 }),
      order({ order_number: "VL-4", tax_state: "CA" }),
    ];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    const tx = report.byState.find((s) => s.state === "TX");
    expect(tx?.netTax).toBe(0);
    expect(report.byState.every((s) => s.netTax >= 0)).toBe(true);
    expect(report.totals.netTax).toBe(8);
  });

  it("still ignores orders that never collected the tax", async () => {
    table = [
      order({ order_number: "VL-5", payment_status: "pending_payment", amount_paid: 108 }),
      order({ order_number: "VL-6", payment_status: "canceled" }),
      order({ order_number: "VL-7", payment_status: "payment_failed" }),
    ];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.rows).toHaveLength(0);
    expect(report.totals.taxCollected).toBe(0);
  });

  it("trusts the status when a refunded row carries no refund_amount", async () => {
    // Rows written before refund_amount was populated: the status is the only
    // evidence that money went back, so it must not be read as a clean sale.
    table = [order({ order_number: "VL-8", payment_status: "refunded", refund_amount: 0 })];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.totals.taxRefunded).toBe(8);
    expect(report.totals.netTax).toBe(0);
  });

  it("never refunds more tax than was collected", async () => {
    // A refund recorded above amount_paid is already flagged by reconciliation;
    // the tax report must not turn it into a negative liability.
    table = [order({ order_number: "VL-9", payment_status: "refunded", refund_amount: 500 })];
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.totals.taxRefunded).toBe(8);
    expect(report.totals.netTax).toBe(0);
  });
});
