import { describe, expect, it } from "vitest";
import { computeOrderProfit } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// TWO DIFFERENT FREIGHT COSTS, AND THEY MUST NEVER MERGE.
//
//   INBOUND   the supplier's $500 delivery, allocated at ~$0.43 per vial and
//             baked into each SKU's landed cost. It is part of COGS. It was
//             already paid, once, on the whole shipment.
//
//   OUTBOUND  the Shippo label for one customer's parcel. A per-order expense,
//             estimated until the label is bought and exact afterwards.
//
// Counting the outbound twice -- estimate AND actual -- would understate profit
// by roughly the postage on every order, and it would look plausible, because
// both numbers are individually correct. The guard is that the two are selected
// exclusively, never summed.
// ---------------------------------------------------------------------------

const base = {
  netMerchandiseRevenue: 100,
  shippingRevenue: 15,
  additionalRevenue: 0,
  processingFee: 8,
  commission: 0,
  refund: 0,
  taxCollected: 5,
  lines: [],
  fallbackUnitCostCents: 0,
};

describe("inbound freight and outbound postage stay separate", () => {
  // COGS already contains the allocated inbound freight. Postage is its own
  // line. The two appear once each and never overlap.
  it("deducts COGS and postage as two distinct expense lines", () => {
    const r = computeOrderProfit({
      ...base,
      lines: [{ quantity: 2, unitCostCents: 1875 }], // 2 x GLP-3 30mg landed
      shippingCost: 6.8,
      shippingCostIsEstimate: false,
    });

    const keys = r.expenses.map((e) => e.key);
    expect(keys.filter((k) => k === "cogs")).toHaveLength(1);
    expect(keys.filter((k) => k === "shipping_cost")).toHaveLength(1);
    expect(r.cogs).toBe(37.5);
    expect(r.shippingCost).toBe(6.8);
  });

  // The one that would be invisible: an order carrying both the pre-label
  // estimate and the settled cost.
  it("never shows two shipping expense lines", () => {
    for (const isEstimate of [true, false]) {
      const r = computeOrderProfit({ ...base, shippingCost: 6.8, shippingCostIsEstimate: isEstimate });
      expect(r.expenses.filter((e) => e.kind === "shipping")).toHaveLength(1);
    }
  });

  it("labels the line honestly in each state", () => {
    const estimated = computeOrderProfit({ ...base, shippingCost: 6, shippingCostIsEstimate: true });
    const actual = computeOrderProfit({ ...base, shippingCost: 6.8, shippingCostIsEstimate: false });

    expect(estimated.expenses.find((e) => e.kind === "shipping")?.label).toContain("estimated");
    expect(actual.expenses.find((e) => e.kind === "shipping")?.label).not.toContain("estimated");
  });

  // Shipping charged to the customer offsets the postage; it is revenue, not a
  // reduction of the expense. Netting them would hide both numbers.
  it("keeps shipping charged as revenue and postage as expense", () => {
    const r = computeOrderProfit({ ...base, shippingCost: 6.8, shippingCostIsEstimate: false });

    expect(r.shippingCharged).toBe(15);
    expect(r.shippingCost).toBe(6.8);
    expect(r.shippingProfit).toBeCloseTo(8.2, 2);
  });

  // The worked example: revenue 100 + shipping 15 - COGS 37.50 - postage 6.80
  // - fee 8 = 62.70. Sales tax is not in it.
  it("arrives at the figure a human would compute by hand", () => {
    const r = computeOrderProfit({
      ...base,
      lines: [{ quantity: 2, unitCostCents: 1875 }],
      shippingCost: 6.8,
      shippingCostIsEstimate: false,
    });

    expect(r.profit).toBeCloseTo(100 + 15 - 37.5 - 6.8 - 8, 2);
    expect(r.taxCollected).toBe(5);
    expect(r.profit).not.toBeCloseTo(100 + 15 + 5 - 37.5 - 6.8 - 8, 2);
  });
});
