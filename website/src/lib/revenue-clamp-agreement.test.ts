import { describe, expect, it } from "vitest";
import { netOrderRevenue } from "@/lib/ledger";
import { computeOrderProfit } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// ONE CONVENTION FOR REVENUE AT THE OVER-REFUND BOUNDARY.
//
// `ledger.netOrderRevenue` clamped with `Math.max(0, paid − refunded)`; the
// profit engine did not. An order paid $100 and refunded $150 therefore
// reported −$50 of revenue on the profit dashboard and $0 on /admin/revenue,
// analytics, the campaign report and the SQL rollups — the two halves of a
// system whose stated premise is that every surface reaches the SAME definition
// of revenue.
//
// THE CONVENTION CHOSEN IS "REVENUE IS CASH": collected minus returned, signed.
// A clamp does not make the money come back; it hides a real loss behind a
// floor of zero and reports the store as having broken even on an order it lost
// money on. Whichever surface a reader happens to open, an over-refunded order
// now says the same thing, and it says the truth.
//
// Reachable? Not from the admin refund route, which caps a reimbursement at the
// cash remaining, nor from refund-effect-repair, which writes refund_amount =
// amount_paid. It is one hand-corrected refund row away, which is exactly when
// a definitional disagreement is most expensive to discover.
// ---------------------------------------------------------------------------

/** Cash collected minus cash returned. The definition, written once. */
const cashKept = (paid: number, refunded: number) => Math.round((paid - refunded) * 100) / 100;

/**
 * The profit engine's revenue for a pure-merchandise order, with tax counted as
 * profit so the reversal is symmetric and `revenue` is exactly cash.
 */
function engineRevenue(paid: number, refunded: number): number {
  return computeOrderProfit({
    netMerchandiseRevenue: paid,
    shippingRevenue: 0,
    shippingCost: 0,
    lines: [],
    commission: 0,
    processingFee: 0,
    refund: refunded,
    countTaxAsProfit: true,
  }).revenue;
}

const CASES: Array<{ label: string; paid: number; refunded: number }> = [
  { label: "no refund", paid: 200, refunded: 0 },
  { label: "partial refund", paid: 200, refunded: 50 },
  { label: "exact full refund", paid: 200, refunded: 200 },
  { label: "over-refund by a cent", paid: 200, refunded: 200.01 },
  { label: "over-refund", paid: 100, refunded: 150 },
  { label: "a refund on an order that collected no cash", paid: 0, refunded: 25 },
];

describe("the ledger helper and the profit engine agree about revenue", () => {
  it.each(CASES)("$label: both report cash kept", ({ paid, refunded }) => {
    const expected = cashKept(paid, refunded);
    expect(netOrderRevenue({ amount_paid: paid, refund_amount: refunded })).toBe(expected);
    expect(engineRevenue(paid, refunded)).toBe(expected);
  });

  it("the over-refunded order is signed, not floored", () => {
    // The specific number money-recert reproduced. Stated outright so a clamp
    // reintroduced anywhere fails on the value, not just on the comparison.
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 150 })).toBe(-50);
    expect(engineRevenue(100, 150)).toBe(-50);
  });

  it("still coerces missing values to zero rather than NaN", () => {
    expect(netOrderRevenue({ amount_paid: null, refund_amount: null })).toBe(0);
    expect(netOrderRevenue({})).toBe(0);
  });
});
