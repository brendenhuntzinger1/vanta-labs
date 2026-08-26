import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeOrderProfit } from "@/lib/order-profit";
import { buildReplacementItems } from "@/lib/admin-replacements";
import { isSaleOrder } from "@/lib/ledger";

// ===========================================================================
// A REPLACEMENT IS NOT A SALE AND NOT A REFUND.
//
//   $0 new revenue
// + new physical inventory out
// + new product COGS
// + new postage expense
// + new shipment, new tracking
// permanently linked to the original PAID order.
//
// The original customer payment is never touched. These tests pin each half of
// that sentence, and the arithmetic is computed by hand rather than by calling
// the accounting engine.
// ===========================================================================

const replacements = readFileSync("src/lib/admin-replacements.ts", "utf8");
const profitLib = readFileSync("src/lib/admin-profit.ts", "utf8");
const route = readFileSync("src/app/api/admin/orders/[orderId]/route.ts", "utf8");

describe("a replacement never touches the payment processor", () => {
  it("creates no payment and carries no payment id", () => {
    expect(replacements).toContain("payment_id: null");
    expect(replacements).toContain('payment_method: "replacement"');
    // Nothing in this module may reach Veyra.
    expect(replacements).not.toContain("getPaymentProvider");
    expect(replacements).not.toContain("refundPayment");
    expect(replacements).not.toContain("createCheckoutSession");
  });

  it("zeroes every money field, so it can never read as revenue", () => {
    for (const field of [
      "subtotal: 0", "shipping_amount: 0", "tax_amount: 0",
      "discount_amount: 0", "amount_paid: 0", "card_processing_fee: 0",
    ]) {
      expect(replacements).toContain(field);
    }
  });

  it("earns no commission, points or coupon", () => {
    expect(replacements).toContain("referral_code: null");
    expect(replacements).toContain("ambassador_id: null");
    expect(replacements).toContain("coupon_code: null");
    expect(replacements).toContain("points_redeemed: 0");
  });

  it("is a NEW order row — the original is never modified", () => {
    const fn = replacements.slice(replacements.indexOf("export async function createReplacementOrder"));
    expect(fn).toContain('from("orders").insert');
    // No update against the original order anywhere in creation.
    expect(fn).not.toMatch(/from\("orders"\)\s*\.update/);
  });

  it("stays linked to the order it replaces, with a reason", () => {
    expect(replacements).toContain("replacement_of: original.order_id");
    expect(replacements).toContain("replacement_reason");
  });

  it("can only be sent for an order that was actually paid", () => {
    expect(replacements).toContain("Replacements can only be sent for paid orders.");
  });
});

describe("duplicate protection", () => {
  it("derives the order id from the request id, so a repeat collides on the primary key", () => {
    // THE DEFECT: every call minted `order-${randomUUID()}`, so a double-click,
    // a retried fetch or a second tab created TWO replacement orders — two
    // parcels, two labels, two lots of postage, stock deducted twice.
    expect(replacements).toContain("order-rp-");
    expect(replacements).toContain('.update(`${input.originalOrderId}::${input.requestId}`)');
  });

  it("returns the FIRST replacement instead of erroring on a repeat", () => {
    expect(replacements).toContain("duplicate: true");
  });

  it("the route forwards the request id", () => {
    expect(route).toContain("requestId: typeof body.requestId === \"string\" ? body.requestId : null");
  });
});

describe("inventory movement is never silent", () => {
  it("a failed decrement raises a critical alert instead of being swallowed", () => {
    // THE DEFECT: `catch { /* non-fatal */ }`. Units left the shelf, nothing
    // recorded it, and the drift only surfaced at a physical count.
    expect(replacements).toContain("replacement_inventory_not_decremented");
    expect(replacements).toContain('severity: "critical"');
    expect(replacements).not.toContain("/* non-fatal */");
  });

  it("still deducts stock, because the units really do leave", () => {
    expect(replacements).toContain("decrementInventoryForOrder");
  });
});

describe("quantities cannot exceed what was purchased", () => {
  const original = [
    { id: "1", product_id: "bpc-157::a", product_name: "BPC-157 10mg", quantity: 2 },
    { id: "2", product_id: "reta::b", product_name: "Reta 10mg", quantity: 1 },
  ];

  it("replaces only the selected lines", () => {
    const rows = buildReplacementItems(original, [{ itemId: "1", quantity: 1 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].product_id).toBe("bpc-157::a");
    expect(rows[0].quantity).toBe(1);
  });

  it("clamps a quantity larger than the original purchase", () => {
    // Asking to replace 9 of something they bought 2 of yields 2, not 9.
    expect(buildReplacementItems(original, [{ itemId: "1", quantity: 9 }])[0].quantity).toBe(2);
  });

  it("refuses a line that was never on the original order", () => {
    expect(buildReplacementItems(original, [{ itemId: "999", quantity: 1 }])).toHaveLength(0);
  });

  it("floors a fractional or negative quantity to at least one real unit", () => {
    expect(buildReplacementItems(original, [{ itemId: "1", quantity: 0 }])[0].quantity).toBe(1);
    expect(buildReplacementItems(original, [{ itemId: "1", quantity: -5 }])[0].quantity).toBe(1);
    expect(buildReplacementItems(original, [{ itemId: "1", quantity: 1.9 }])[0].quantity).toBe(1);
  });

  it("replaces the whole order when nothing is selected", () => {
    expect(buildReplacementItems(original, null)).toHaveLength(2);
  });
});

describe("a replacement is not counted as a sale", () => {
  // WAS A PLACEBO. This describe used to assert that admin-profit.ts CONTAINED
  // the literal 'String(row.orderType ?? "").toLowerCase() === "replacement"'.
  // That grep cannot fail for the defect its own comment describes: rewriting
  // the branch to `orderCount += 1` while leaving the string anywhere in the
  // file — in a comment, in an unused local — passes. It did fail, once: on a
  // behaviour-preserving refactor that moved the rule into ledger.ts. A test
  // that goes red on a safe refactor and stays green on the real bug is worse
  // than no test.
  //
  // The rule now lives in ONE place, so it can be exercised directly, and the
  // end-to-end count is pinned behaviourally against a real Postgres in
  // src/lib/admin-financial-surfaces.test.ts ("every surface counts the same
  // 102 sales, and never counts a reship as one").
  it("the ledger predicate says a reship is not a sale", () => {
    expect(isSaleOrder("replacement")).toBe(false);
    // Everything else is. A membership is a real paid sale that simply never
    // ships; excluding it here would erase real revenue from the books.
    expect(isSaleOrder("product")).toBe(true);
    expect(isSaleOrder("membership")).toBe(true);
    // An order predating the column, or with junk in it, is a sale by default —
    // failing open on the count is safer than silently dropping real revenue.
    expect(isSaleOrder(null)).toBe(true);
    expect(isSaleOrder(undefined)).toBe(true);
    expect(isSaleOrder("PRODUCT")).toBe(true);
    // Case-insensitive, so a differently-cased writer cannot smuggle one in.
    expect(isSaleOrder("Replacement")).toBe(false);
  });

  it("100 sales and 3 reships is 100 sales, not 103", () => {
    // The arithmetic the defect got wrong, computed here rather than grepped
    // for: the denominator behind average order value.
    const orderTypes = [
      ...Array.from({ length: 100 }, () => "product"),
      ...Array.from({ length: 3 }, () => "replacement"),
    ];
    const sales = orderTypes.filter(isSaleOrder).length;
    const reships = orderTypes.length - sales;
    expect(sales).toBe(100);
    expect(reships).toBe(3);
    // $21,500 over 100 sales, not over 103 rows.
    expect(Math.round((21500 / sales) * 100) / 100).toBe(215);
  });

  it("but its COSTS are still counted, because they were really spent", () => {
    const loop = profitLib.slice(profitLib.indexOf("replacementCount += 1"));
    // COGS, postage and fees accumulate OUTSIDE the sale/reship branch.
    expect(loop).toContain("totalProductCosts += row.cogs");
    expect(loop).toContain("totalShippingExpense += row.shippingCost");
  });
});

describe("the money, reconciled by hand", () => {
  it("an original order plus a replacement", () => {
    // ORIGINAL: products 200, shipping charged 15, COGS 40, postage 9, fee 6.50
    const originalOrder = computeOrderProfit({
      netMerchandiseRevenue: 200, shippingRevenue: 15, shippingCost: 9,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(originalOrder.revenue).toBe(215);
    expect(originalOrder.profit).toBe(159.5);          // 215 − 40 − 9 − 6.50

    // REPLACEMENT: $0 revenue. COGS 12, postage 7. No fee — nothing was charged.
    const replacement = computeOrderProfit({
      netMerchandiseRevenue: 0, shippingRevenue: 0, shippingCost: 7,
      lines: [{ unitCostCents: 1200, quantity: 1 }],
      commission: 0, processingFee: 0, refund: 0, shippingCostIsEstimate: false,
    });
    expect(replacement.revenue).toBe(0);
    expect(replacement.grossRevenue).toBe(0);
    expect(replacement.cogs).toBe(12);
    expect(replacement.shippingCost).toBe(7);
    // A pure cost: the reship is exactly minus what it consumed.
    expect(replacement.profit).toBe(-19);

    // THE CUSTOMER RELATIONSHIP, end to end.
    const combined = originalOrder.profit + replacement.profit;
    expect(Math.round(combined * 100) / 100).toBe(140.5);   // 159.50 − 19.00

    // And the original payment is untouched by any of it.
    expect(originalOrder.revenue).toBe(215);
  });

  it("100 sales and 3 reships: revenue from 100, costs from 103", () => {
    const sale = () => computeOrderProfit({
      netMerchandiseRevenue: 200, shippingRevenue: 15, shippingCost: 9,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    const reship = () => computeOrderProfit({
      netMerchandiseRevenue: 0, shippingRevenue: 0, shippingCost: 7,
      lines: [{ unitCostCents: 1200, quantity: 1 }],
      commission: 0, processingFee: 0, refund: 0, shippingCostIsEstimate: false,
    });

    const sales = Array.from({ length: 100 }, sale);
    const reships = Array.from({ length: 3 }, reship);
    const money = (n: number) => Math.round(n * 100) / 100;

    // Revenue comes from the 100 sales ONLY.
    expect(money([...sales, ...reships].reduce((t, r) => t + r.revenue, 0))).toBe(215 * 100);

    // Outbound parcels and their postage: 103.
    expect(money([...sales, ...reships].reduce((t, r) => t + r.shippingCost, 0)))
      .toBe(money(9 * 100 + 7 * 3));

    // COGS covers every unit that left the shelf — sales and reships alike.
    expect(money([...sales, ...reships].reduce((t, r) => t + r.cogs, 0)))
      .toBe(40 * 100 + 12 * 3);

    // Profit absorbs the reship cost.
    expect(money([...sales, ...reships].reduce((t, r) => t + r.profit, 0)))
      .toBe(money(159.5 * 100 - 19 * 3));
  });
});
