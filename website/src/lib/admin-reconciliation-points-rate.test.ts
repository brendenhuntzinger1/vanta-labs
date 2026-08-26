import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK F — the points→dollars conversion on the reconciliation screen.
//
// orders.points_redeemed stores POINTS. To rebuild the order's total,
// admin-reconciliation has to turn them back into dollars, and it used to do
// that with a hardcoded `/ 100` — a fifth hand-written copy of a rate that
// already has a name (points-math.POINTS_PER_DOLLAR_REDEMPTION) and a function
// (pointsToDollars) that quote-order charges on.
//
// The two agree today, so nothing was wrong. The test that matters is what
// happens WHEN THEY STOP AGREEING: the rate is an exported constant, which is
// the shape of a value someone is expected to change. This suite changes it and
// asserts the reconciliation screen still gets the right answer — which is only
// true if the conversion goes through points-math rather than a copy of its
// current value.
// ---------------------------------------------------------------------------

/** A rate DIFFERENT from today's 100, to catch a copy of the number. */
const CHANGED_RATE = 200;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/points-math", () => ({
  POINTS_PER_DOLLAR_REDEMPTION: CHANGED_RATE,
  pointsToDollars: (points: number) => Math.round((points / CHANGED_RATE) * 100) / 100,
  dollarsToPoints: (dollars: number) => Math.floor(dollars * CHANGED_RATE),
  calculateEarnedPoints: () => 0,
}));

interface Row {
  order_id: string;
  customer_email: string | null;
  subtotal: number;
  shipping_amount: number;
  discount_amount: number;
  tax_amount: number;
  card_processing_fee: number;
  store_credit_redeemed_cents: number;
  points_redeemed: number;
  amount_paid: number;
  refund_amount: number;
  payment_status: string;
  paid_at: string | null;
  created_at: string;
  shipping_protection_fee: number;
}

let table: Row[] = [];

vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    let from = 0;
    let to = Number.MAX_SAFE_INTEGER;
    const api = {
      order: () => api,
      range: (a: number, b: number) => { from = a; to = b; return api; },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: table.slice(from, to + 1), error: null })),
    };
    return api;
  };
  return { supabaseAdmin: { from: () => ({ select: () => builder() }) } };
});

describe("reconciliation and the points redemption rate", () => {
  it("does not flag a points-redeeming order when the rate is not 100", async () => {
    // 200 points, worth $1.00 at the changed rate (and $2.00 at a copy of the
    // old one). Charged: 100 + 10 shipping + 8 tax − 1 of points = $117.
    table = [{
      order_id: "order-points",
      customer_email: "buyer@example.test",
      subtotal: 100,
      shipping_amount: 10,
      discount_amount: 0,
      tax_amount: 8,
      card_processing_fee: 0,
      store_credit_redeemed_cents: 0,
      points_redeemed: 200,
      amount_paid: 117,
      refund_amount: 0,
      payment_status: "paid",
      paid_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
      shipping_protection_fee: 0,
    }];

    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();

    // A hardcoded `/ 100` would value the 200 points at $2, expect $116, and
    // report the customer as having OVERPAID by a dollar.
    expect(flags.filter((f) => f.type === "total_mismatch")).toEqual([]);
  });

  it("still flags a genuinely wrong total at the changed rate", async () => {
    table = [{
      order_id: "order-broken",
      customer_email: "buyer@example.test",
      subtotal: 100,
      shipping_amount: 10,
      discount_amount: 0,
      tax_amount: 8,
      card_processing_fee: 0,
      store_credit_redeemed_cents: 0,
      points_redeemed: 200,
      amount_paid: 90, // $27 short of the $117 the components imply
      refund_amount: 0,
      payment_status: "paid",
      paid_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
      shipping_protection_fee: 0,
    }];

    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();

    const mismatch = flags.find((f) => f.type === "total_mismatch");
    expect(mismatch?.orderId).toBe("order-broken");
    expect(mismatch?.detail).toContain("117.00");
  });
});
