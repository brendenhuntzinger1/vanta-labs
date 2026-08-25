import { describe, expect, it } from "vitest";

import { buildOrderSummaryLines, sumSummaryLines } from "@/lib/order-summary-breakdown";

// ---------------------------------------------------------------------------
// THE RECEIPT NAMES THE PROTECTION FEE INSTEAD OF GUESSING AT IT.
//
// Shipping protection had no column, so the receipt explained the gap between
// the known columns and amount_paid by surfacing the remainder as a line
// LABELLED "Shipping protection". A guess that was usually right.
//
// orders.shipping_protection_fee now records the real figure. The difference
// shows up on the order that has BOTH a protection fee and a genuine
// adjustment: the residual netted them into one line, so it could show neither
// correctly — or hide a real adjustment behind a plausible protection charge.
//
// The invariant that must never break: THE LINES SUM TO WHAT THE CARD WAS
// CHARGED. A receipt that disagrees with a card statement is worse than no
// receipt.
// ---------------------------------------------------------------------------

const base = { subtotal: 0, shipping: 0, handling: 0, tax: 0, discount: 0, itemsTotal: 0 };

/** The three real production orders, with their now-recorded fees. */
const REAL_ORDERS = [
  { name: "VL-37C1E4B0", subtotal: 2.0, shipping: 15, tax: 0, protection: 0.08, total: 17.08 },
  { name: "VL-8D132452", subtotal: 3.8, shipping: 15, tax: 0, protection: 0.15, total: 18.95 },
  { name: "VL-E8F4D52F", subtotal: 54.99, shipping: 15, tax: 3.85, protection: 2.2, total: 76.04 },
];

describe("a recorded fee is rendered as itself", () => {
  it.each(REAL_ORDERS)("$name shows a real Shipping protection line that sums to the charge", (order) => {
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: order.subtotal,
      shipping: order.shipping,
      tax: order.tax,
      shippingProtection: order.protection,
      total: order.total,
    });

    const protection = lines.filter((line) => line.key === "protection");
    expect(protection).toHaveLength(1);
    expect(protection[0].amount).toBe(order.protection);
    // No leftover masquerading as something else.
    expect(lines.filter((line) => line.key === "adjustment")).toHaveLength(0);
    expect(sumSummaryLines(lines)).toBe(order.total);
  });
});

describe("the case the old residual could not represent", () => {
  /**
   * A $2.20 protection fee AND a $5.00 post-hoc credit. The residual approach
   * saw only their net (−$2.80) and would have shown a single "Adjustment"
   * line, erasing the protection charge the customer actually paid.
   */
  it("shows the fee AND the credit separately", () => {
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 54.99,
      shipping: 15,
      tax: 3.85,
      shippingProtection: 2.2,
      total: 76.04 - 5,
    });

    expect(lines.find((l) => l.key === "protection")?.amount).toBe(2.2);
    const adjustment = lines.find((l) => l.key === "adjustment");
    expect(adjustment?.amount).toBe(-5);
    expect(adjustment?.tone).toBe("credit");
    expect(sumSummaryLines(lines)).toBe(71.04);
  });

  /**
   * With a fee already named, a FURTHER positive remainder is not more
   * protection — labelling it that way would invent a second protection charge
   * on the customer's receipt.
   */
  it("does not invent a second protection charge", () => {
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 10,
      shipping: 5,
      shippingProtection: 0.4,
      total: 18.4, // $3 unexplained on top of the recorded fee
    });

    expect(lines.filter((l) => l.key === "protection")).toHaveLength(1);
    expect(lines.find((l) => l.key === "protection")?.amount).toBe(0.4);
    expect(lines.find((l) => l.key === "adjustment")?.amount).toBe(3);
    expect(sumSummaryLines(lines)).toBe(18.4);
  });
});

describe("orders written before the column existed are unchanged", () => {
  /**
   * shipping_protection_fee is 0 on those rows. Their fee must still be
   * explained, by the old residual route, or the receipt stops adding up.
   */
  it("still labels the remainder Shipping protection when no fee was recorded", () => {
    const lines = buildOrderSummaryLines({
      ...base,
      subtotal: 54.99,
      shipping: 15,
      tax: 3.85,
      total: 76.04,
      // shippingProtection deliberately omitted — a pre-column row.
    });

    expect(lines.find((l) => l.key === "protection")?.amount).toBe(2.2);
    expect(sumSummaryLines(lines)).toBe(76.04);
  });

  it("an order with neither a fee nor a remainder shows no protection line", () => {
    const lines = buildOrderSummaryLines({ ...base, subtotal: 10, shipping: 5, total: 15 });
    expect(lines.filter((l) => l.key === "protection")).toHaveLength(0);
    expect(sumSummaryLines(lines)).toBe(15);
  });
});

describe("the invariant, whatever the inputs", () => {
  it("always sums to the settled charge", () => {
    const cases = [
      { ...base, subtotal: 100, shipping: 15, tax: 8, discount: 10, handling: 2, shippingProtection: 4, total: 119 },
      { ...base, subtotal: 0, itemsTotal: 42, shipping: 0, shippingProtection: 1.68, total: 43.68 },
      { ...base, subtotal: 20, shipping: 5, shippingProtection: 0.8, total: 20 },
      { ...base, subtotal: 20, shipping: 5, shippingProtection: 0, total: 25 },
    ];
    for (const amounts of cases) {
      expect(sumSummaryLines(buildOrderSummaryLines(amounts))).toBe(amounts.total);
    }
  });
});
