import { describe, expect, it } from "vitest";

import { buildOrderSummaryLines, sumSummaryLines } from "@/lib/order-summary-breakdown";
import { DEFAULT_CARD_PROCESSING_FEE } from "@/lib/payment-methods";

// ---------------------------------------------------------------------------
// THE CARD SERVICE FEE IS ITS OWN CHARGE, NOT A RESIDUAL.
//
// Reproduced in the browser on order VL-284C17AD: shipping protection was
// explicitly DECLINED at checkout, yet the confirmation page rendered
//
//     Shipping protection      $10.35
//
// $10.35 was the 3% card service fee. The database agreed with neither:
//
//     shipping_protection_fee = 0.00
//     card_processing_fee     = 10.35
//
// buildOrderSummaryLines() summed subtotal - discount + shipping + handling +
// tax + protection. The card fee appeared in NONE of those terms, so it fell
// into the leftover "residual" -- which is labelled "Shipping protection"
// whenever no protection fee was recorded.
//
// Consequence: a customer who declined protection is told they bought it, and
// a customer who DID buy it sees their fee as an unexplained "Adjustment".
//
// The invariant that must never break stays the same: THE LINES SUM TO WHAT
// THE CARD WAS CHARGED.
// ---------------------------------------------------------------------------

const base = { subtotal: 0, shipping: 0, handling: 0, tax: 0, discount: 0, itemsTotal: 0 };

const FEE_LABEL = DEFAULT_CARD_PROCESSING_FEE.label;

function labels(lines: ReturnType<typeof buildOrderSummaryLines>) {
  return lines.map((line) => line.label);
}

function lineFor(lines: ReturnType<typeof buildOrderSummaryLines>, label: string) {
  return lines.find((line) => line.label === label);
}

/** The order actually walked through the browser during the checkout audit. */
const VL_284C17AD = {
  ...base,
  subtotal: 344.96,
  shipping: 0,
  tax: 0,
  discount: 0,
  shippingProtection: 0,
  cardProcessingFee: 10.35,
  total: 355.31,
};

describe("a recorded card service fee is rendered as itself", () => {
  it("names the fee on the reproduced order VL-284C17AD", () => {
    const lines = buildOrderSummaryLines(VL_284C17AD);

    expect(lineFor(lines, FEE_LABEL)).toMatchObject({ key: "cardFee", amount: 10.35 });
    expect(sumSummaryLines(lines)).toBe(355.31);
  });

  it("does NOT call a declined protection fee a protection charge", () => {
    const lines = buildOrderSummaryLines(VL_284C17AD);

    // The exact defect: protection was declined, so no protection line may
    // exist at any amount.
    expect(labels(lines)).not.toContain("Shipping protection");
    expect(lines.some((line) => line.key === "protection")).toBe(false);
  });

  it("does not hide the fee behind an unexplained adjustment either", () => {
    const lines = buildOrderSummaryLines(VL_284C17AD);

    expect(labels(lines)).not.toContain("Adjustment");
    expect(lines.some((line) => line.key === "adjustment")).toBe(false);
  });

  it("keeps protection and the service fee as two separate lines when both apply", () => {
    // Same cart, but this shopper DID take protection at $13.80. Both charges
    // are real and distinct; neither may absorb the other.
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 344.96,
      shippingProtection: 13.8,
      cardProcessingFee: 10.76,
      total: 369.52,
    });

    expect(lineFor(lines, "Shipping protection")).toMatchObject({ amount: 13.8 });
    expect(lineFor(lines, FEE_LABEL)).toMatchObject({ amount: 10.76 });
    expect(labels(lines)).not.toContain("Adjustment");
    expect(sumSummaryLines(lines)).toBe(369.52);
  });

  it("still surfaces a genuine adjustment alongside both recorded fees", () => {
    // A real unmodelled remainder must still surface rather than silently
    // breaking the sum -- it just may not be called protection or a fee.
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 100,
      shippingProtection: 5,
      cardProcessingFee: 3,
      total: 115,
    });

    expect(lineFor(lines, "Shipping protection")).toMatchObject({ amount: 5 });
    expect(lineFor(lines, FEE_LABEL)).toMatchObject({ amount: 3 });
    expect(lineFor(lines, "Adjustment")).toMatchObject({ amount: 7 });
    expect(sumSummaryLines(lines)).toBe(115);
  });

  it("uses a caller-supplied label when an admin has renamed the fee", () => {
    const lines = buildOrderSummaryLines({ ...VL_284C17AD, cardFeeLabel: "Processing Fee" });

    expect(lineFor(lines, "Processing Fee")).toMatchObject({ key: "cardFee", amount: 10.35 });
    expect(labels(lines)).not.toContain("Shipping protection");
  });
});

describe("orders written before the card-fee column keep their old behaviour", () => {
  it("still explains a pre-column residual as Shipping protection", () => {
    // VL-E8F4D52F, a real order from before either column existed. With no
    // recorded protection AND no recorded fee, the residual keeps the historic
    // label -- changing it would rewrite receipts that were already correct.
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 54.99,
      shipping: 15,
      tax: 3.85,
      total: 76.04,
    });

    expect(lineFor(lines, "Shipping protection")).toMatchObject({ amount: 2.2 });
    expect(sumSummaryLines(lines)).toBe(76.04);
  });

  it("omits the fee line entirely when no fee was charged", () => {
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 50,
      shipping: 10,
      cardProcessingFee: 0,
      total: 60,
    });

    expect(lines.some((line) => line.key === "cardFee")).toBe(false);
    expect(sumSummaryLines(lines)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// A test that passes against BOTH the old and the new implementation would not
// have caught this bug. `legacyAccountedTotal` reproduces the pre-fix maths
// exactly -- the sum with the card fee missing from its terms. Asserting the
// residual it produces proves the assertions above genuinely discriminate
// between old and new behaviour rather than passing vacuously.
// ---------------------------------------------------------------------------
describe("negative control: the old maths really did mislabel the fee", () => {
  function legacyResidual(a: typeof VL_284C17AD) {
    // Pre-fix: cardProcessingFee was absent from this sum.
    const accounted =
      a.subtotal - a.discount + a.shipping + a.handling + a.tax + (a.shippingProtection ?? 0);
    return Math.round((a.total - accounted) * 100) / 100;
  }

  it("the old sum leaves the card fee unexplained, which is why it was mislabelled", () => {
    // The residual IS the card fee, to the cent -- and with protection at 0 the
    // old code labelled exactly this amount "Shipping protection".
    expect(legacyResidual(VL_284C17AD)).toBe(10.35);
    expect(VL_284C17AD.shippingProtection).toBe(0);
  });

  it("the new implementation leaves nothing unexplained on that same order", () => {
    const lines = buildOrderSummaryLines(VL_284C17AD);
    const residualLines = lines.filter(
      (line) => line.key === "adjustment" || line.key === "protection",
    );

    expect(residualLines).toEqual([]);
    expect(sumSummaryLines(lines)).toBe(VL_284C17AD.total);
  });
});
