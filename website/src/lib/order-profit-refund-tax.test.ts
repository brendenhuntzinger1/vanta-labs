import { describe, expect, it } from "vitest";
import { computeOrderProfit } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// BLOCK F — a refund reverses the revenue that was counted, and only that.
//
// `refund` is everything handed back to the customer, and that includes the
// sales tax charged on the sale. Whether the tax was ever COUNTED as revenue is
// a setting: admin-control's `count_sales_tax_as_profit` ("True = the owner
// keeps it; false = it's a pass-through remitted to the state").
//
// With the toggle ON, tax is inside grossRevenue and the two cancel: a fully
// refunded order nets to zero. With it OFF, tax was never added — but the whole
// refund was still being subtracted, so the order reported NEGATIVE revenue
// equal to its own tax and a profit that much worse than the truth.
//
// This store operates a real sales-tax remittance report, so "pass-through" is
// the setting the business is heading for, not a hypothetical.
// ---------------------------------------------------------------------------

// A $100 order: $10 shipping, $8 tax, $9 card surcharge → amount_paid $127.
// Cost to serve: $6 of shipping. additionalRevenue is the $9 surcharge.
const order = (over: Record<string, unknown> = {}) => ({
  netMerchandiseRevenue: 100,
  shippingRevenue: 10,
  additionalRevenue: 9,
  shippingCost: 6,
  taxCollected: 8,
  lines: [],
  commission: 0,
  processingFee: 0,
  refund: 0,
  fallbackUnitCostCents: 0,
  ...over,
});

describe("refunds when collected tax is a pass-through", () => {
  it("a full refund nets revenue to zero, not to minus the tax", () => {
    const r = computeOrderProfit(order({ countTaxAsProfit: false, refund: 127, refundedTax: 8 }));

    expect(r.grossRevenue).toBe(119); // tax excluded, as configured
    // Was −8: the $8 of tax was deducted from revenue it was never added to.
    expect(r.revenue).toBe(0);
    // The only thing left is the real cost of having shipped it.
    expect(r.profit).toBe(-6);
  });

  it("a partial refund reverses only its non-tax share", () => {
    // Half the money back: $63.50, of which $4 is tax.
    const r = computeOrderProfit(order({ countTaxAsProfit: false, refund: 63.5, refundedTax: 4 }));

    expect(r.revenue).toBe(119 - 59.5);
  });

  it("is unchanged when tax counts as profit", () => {
    // The default path. Tax is inside grossRevenue, so the whole refund is the
    // correct reversal and refundedTax is unused.
    const withHint = computeOrderProfit(order({ countTaxAsProfit: true, refund: 127, refundedTax: 8 }));
    const without = computeOrderProfit(order({ countTaxAsProfit: true, refund: 127 }));

    expect(withHint.revenue).toBe(0);
    expect(without.revenue).toBe(0);
    expect(withHint.profit).toBe(without.profit);
  });

  it("never credits back more tax than was collected", () => {
    // A refund_amount recorded above amount_paid is a data error reconciliation
    // already flags; it must not become extra revenue here.
    const r = computeOrderProfit(order({ countTaxAsProfit: false, refund: 127, refundedTax: 500 }));
    expect(r.revenue).toBe(0);
    expect(r.revenue).toBeGreaterThanOrEqual(0);
  });

  it("leaves an unrefunded order completely untouched", () => {
    const passthrough = computeOrderProfit(order({ countTaxAsProfit: false }));
    const counted = computeOrderProfit(order({ countTaxAsProfit: true }));

    expect(passthrough.revenue).toBe(119);
    expect(counted.revenue).toBe(127);
  });
});
