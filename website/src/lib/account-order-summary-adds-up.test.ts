import { describe, expect, it } from "vitest";

import { buildOrderSummaryLines, sumSummaryLines } from "@/lib/order-summary-breakdown";

// ---------------------------------------------------------------------------
// THE ROWS A CUSTOMER SEES MUST ADD UP TO WHAT THEIR CARD WAS CHARGED.
//
// The account order-detail page hand-listed five terms — subtotal, discount,
// shipping, handling, tax — and the order row carries two more that are really
// charged: shipping_protection_fee and card_processing_fee. Measured in a
// browser on order VL-CD07E93C during the audit:
//
//     Subtotal      $14.99
//     Discount      −$1.50
//     Shipping      $15.00
//     Total paid    $30.27      <- rows above sum to $28.49
//
// $1.78 of the charge was unexplained and unlabelled, on the one page a
// customer opens to check a charge. Both fees were already loaded by the page's
// own data source, and both were itemised correctly on the invoice, the emailed
// receipt, the confirmation page and the admin order page — so the store told
// this customer two different stories about the same order.
//
// The page now derives its rows from buildOrderSummaryLines, which every one of
// those other surfaces already uses, and which keeps a residual line so an
// unmodelled remainder is VISIBLE rather than silently missing. The summary
// adds up by construction rather than by five lists being kept in step by hand.
// ---------------------------------------------------------------------------

/** The real order the defect was measured on. */
const VL_CD07E93C = {
  total: 30.27,
  subtotal: 14.99,
  shipping: 15.0,
  handling: 0,
  tax: 0,
  discount: 1.5,
  shippingProtection: 0.9,
  cardProcessingFee: 0.88,
  itemsTotal: 14.99,
};

describe("the account order summary reconciles to the charge", () => {
  it("sums to the amount actually paid", () => {
    const lines = buildOrderSummaryLines(VL_CD07E93C);
    expect(sumSummaryLines(lines)).toBeCloseTo(30.27, 2);
  });

  it("itemises both fees that used to be missing", () => {
    const keys = buildOrderSummaryLines(VL_CD07E93C).map((l) => l.key);
    expect(keys).toContain("protection");
    expect(keys).toContain("cardFee");
  });

  it("leaves no unexplained residual on this order", () => {
    // A residual line is the safety net, not the answer. When every term is
    // modelled there should be nothing left over to label.
    const lines = buildOrderSummaryLines(VL_CD07E93C);
    expect(lines.find((l) => l.key === "adjustment")).toBeUndefined();
  });

  it("the five rows the page used to show do NOT sum to the charge", () => {
    // The defect itself, pinned. If someone reverts to the hand-rolled list,
    // this is the arithmetic that was wrong.
    const oldRows = VL_CD07E93C.subtotal - VL_CD07E93C.discount + VL_CD07E93C.shipping
      + VL_CD07E93C.handling + VL_CD07E93C.tax;
    expect(oldRows).toBeCloseTo(28.49, 2);
    expect(Math.abs(oldRows - VL_CD07E93C.total)).toBeCloseTo(1.78, 2);
  });

  it("still reconciles an order carrying no optional fees at all", () => {
    const plain = { total: 62.99, subtotal: 47.99, shipping: 15.0, handling: 0, tax: 0, discount: 0, itemsTotal: 47.99 };
    expect(sumSummaryLines(buildOrderSummaryLines(plain))).toBeCloseTo(62.99, 2);
  });

  it("surfaces a remainder it cannot name rather than hiding it", () => {
    // An order written before a fee column existed: the money is real, the term
    // is unknown, and the customer must still see the charge accounted for.
    //
    // The helper labels THIS shape "Shipping protection" rather than
    // "Adjustment", deliberately — an order predating both fee columns almost
    // certainly had its protection fee land in the residual, and the comment at
    // order-summary-breakdown.ts:54-57 records that reasoning. Only an order
    // that already lists a recorded fee gets the neutral "Adjustment", because
    // naming a second protection charge there would invent one.
    const legacy = { total: 50.0, subtotal: 30.0, shipping: 15.0, handling: 0, tax: 0, discount: 0, itemsTotal: 30.0 };
    const lines = buildOrderSummaryLines(legacy);
    expect(lines.find((l) => l.key === "protection")).toBeDefined();
    expect(sumSummaryLines(lines)).toBeCloseTo(50.0, 2);
  });

  it("calls an unexplained remainder an adjustment once a fee is already listed", () => {
    // Same residual, but this order records a card fee — so it is new enough
    // that the leftover is not a missing protection charge.
    const modern = {
      total: 50.0, subtotal: 30.0, shipping: 15.0, handling: 0, tax: 0, discount: 0,
      cardProcessingFee: 1.0, itemsTotal: 30.0,
    };
    const lines = buildOrderSummaryLines(modern);
    expect(lines.find((l) => l.key === "adjustment")).toBeDefined();
    expect(sumSummaryLines(lines)).toBeCloseTo(50.0, 2);
  });
});
