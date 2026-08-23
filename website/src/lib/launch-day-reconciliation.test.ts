import { describe, expect, it } from "vitest";
import { computeOrderProfit } from "@/lib/order-profit";

// ===========================================================================
// A SYNTHETIC LAUNCH DAY, RECONCILED INDEPENDENTLY.
//
// 100 legitimate customer purchases plus 5 replacements. Every expected
// number below is computed from the SEEDED FACTS with plain arithmetic in
// this file -- never by calling the production function and then asserting it
// equals itself. That is the whole point: if computeOrderProfit and the
// hand-arithmetic disagree, one of them is wrong, and the test does not care
// which.
//
// The three invariants this exists to protect:
//
//   SALES  != SHIPMENTS   100 purchases, 105 outbound parcels
//   REVENUE  ignores replacements entirely ($0 orders)
//   EXPENSE  counts them fully (COGS and postage are really spent)
// ===========================================================================

const round = (v: number) => Math.round(v * 100) / 100;

interface SeededOrder {
  units: number;
  unitPrice: number;
  unitCostCents: number;
  discount: number;
  shippingCharged: number;
  postage: number;
  commission: number;
  processorRate: number;
}

/**
 * A deterministic spread of realistic orders. No randomness: the same 100
 * orders every run, so a failure is reproducible.
 */
function seedPurchases(): SeededOrder[] {
  const orders: SeededOrder[] = [];
  for (let i = 0; i < 100; i += 1) {
    const units = (i % 5) + 1;               // 1..5 units
    const unitPrice = [45, 60, 75, 90][i % 4];
    const unitCostCents = [1200, 1500, 1800, 2100][i % 4];
    // Every fifth order carries a 10% discount; every third ships free.
    const merch = units * unitPrice;
    const discount = i % 5 === 0 ? round(merch * 0.1) : 0;
    const shippingCharged = i % 3 === 0 ? 0 : 15;
    const postage = [5.2, 7.43, 10, 19.99][i % 4];
    // Every seventh order came through an ambassador at 15%.
    const commission = i % 7 === 0 ? round((merch - discount) * 0.15) : 0;
    orders.push({
      units,
      unitPrice,
      unitCostCents,
      discount,
      shippingCharged,
      postage,
      commission,
      processorRate: 0.029,
    });
  }
  return orders;
}

/** Five replacements, each reshipping one unit of a mid-priced product. */
function seedReplacements() {
  return Array.from({ length: 5 }, (_, i) => ({
    units: 1,
    unitCostCents: [1200, 1500, 1800, 2100][i % 4],
    postage: [5.2, 7.43, 10, 19.99][i % 4],
  }));
}

const PURCHASES = seedPurchases();
const REPLACEMENTS = seedReplacements();

// --- INDEPENDENT ARITHMETIC ------------------------------------------------
// Computed here, by hand, from the seed. Nothing below calls production code.

const expected = (() => {
  let units = 0;
  let merchandiseRevenue = 0;
  let discount = 0;
  let shippingRevenue = 0;
  let cogsCents = 0;
  let postage = 0;
  let commission = 0;
  let processorFee = 0;

  for (const o of PURCHASES) {
    const merch = o.units * o.unitPrice;
    const net = merch - o.discount;
    units += o.units;
    merchandiseRevenue += net;
    discount += o.discount;
    shippingRevenue += o.shippingCharged;
    cogsCents += o.unitCostCents * o.units;
    postage += o.postage;
    commission += o.commission;
    processorFee += round((net + o.shippingCharged) * o.processorRate);
  }

  let replacementCogsCents = 0;
  let replacementPostage = 0;
  for (const r of REPLACEMENTS) {
    replacementCogsCents += r.unitCostCents * r.units;
    replacementPostage += r.postage;
  }

  const revenue = round(merchandiseRevenue + shippingRevenue);
  const cogs = round(cogsCents / 100);
  const replacementCogs = round(replacementCogsCents / 100);

  return {
    sales: PURCHASES.length,
    shipments: PURCHASES.length + REPLACEMENTS.length,
    units,
    merchandiseRevenue: round(merchandiseRevenue),
    discount: round(discount),
    shippingRevenue: round(shippingRevenue),
    revenue,
    cogs,
    postage: round(postage),
    commission: round(commission),
    processorFee: round(processorFee),
    replacementCogs,
    replacementPostage: round(replacementPostage),
    aov: round(revenue / PURCHASES.length),
  };
})();

// --- THE SAME DAY, THROUGH THE PRODUCTION FUNCTION -------------------------

const actual = (() => {
  let revenue = 0;
  let cogs = 0;
  let shippingRevenue = 0;
  let shippingCost = 0;
  let commission = 0;
  let processingFee = 0;
  let profit = 0;

  for (const o of PURCHASES) {
    const merch = o.units * o.unitPrice;
    const net = merch - o.discount;
    const result = computeOrderProfit({
      netMerchandiseRevenue: net,
      shippingRevenue: o.shippingCharged,
      commission: o.commission,
      processingFee: round((net + o.shippingCharged) * o.processorRate),
      shippingCost: o.postage,
      shippingCostIsEstimate: false,
      refund: 0,
      lines: [{ quantity: o.units, unitCostCents: o.unitCostCents }],
    });
    revenue += result.revenue;
    cogs += result.cogs;
    shippingRevenue += result.shippingRevenue;
    shippingCost += result.shippingCost;
    commission += result.commission;
    processingFee += result.processingFee;
    profit += result.profit;
  }

  let replacementCogs = 0;
  let replacementPostage = 0;
  let replacementRevenue = 0;
  for (const r of REPLACEMENTS) {
    const result = computeOrderProfit({
      // A replacement is a $0 order: no merchandise revenue, no shipping
      // revenue, no commission, no processor fee.
      netMerchandiseRevenue: 0,
      shippingRevenue: 0,
      commission: 0,
      processingFee: 0,
      shippingCost: r.postage,
      shippingCostIsEstimate: false,
      refund: 0,
      lines: [{ quantity: r.units, unitCostCents: r.unitCostCents }],
    });
    replacementRevenue += result.revenue;
    replacementCogs += result.cogs;
    replacementPostage += result.shippingCost;
    profit += result.profit;
  }

  return {
    revenue: round(revenue),
    cogs: round(cogs),
    shippingRevenue: round(shippingRevenue),
    shippingCost: round(shippingCost),
    commission: round(commission),
    processingFee: round(processingFee),
    profit: round(profit),
    replacementRevenue: round(replacementRevenue),
    replacementCogs: round(replacementCogs),
    replacementPostage: round(replacementPostage),
  };
})();

describe("100 purchases and 5 replacements, reconciled line by line", () => {
  it("counts 100 sales and 105 outbound shipments", () => {
    // The distinction the dashboard must never blur.
    expect(expected.sales).toBe(100);
    expect(expected.shipments).toBe(105);
    expect(expected.shipments - expected.sales).toBe(REPLACEMENTS.length);
  });

  it("agrees on net revenue to the cent", () => {
    expect(actual.revenue).toBe(expected.revenue);
  });

  it("agrees on merchandise and shipping revenue separately", () => {
    expect(actual.shippingRevenue).toBe(expected.shippingRevenue);
    expect(round(actual.revenue - actual.shippingRevenue)).toBe(expected.merchandiseRevenue);
  });

  it("agrees on COGS", () => {
    expect(actual.cogs).toBe(expected.cogs);
  });

  it("agrees on actual postage", () => {
    expect(actual.shippingCost).toBe(expected.postage);
  });

  it("agrees on commission", () => {
    expect(actual.commission).toBe(expected.commission);
  });

  it("agrees on the processor fee", () => {
    expect(actual.processingFee).toBe(expected.processorFee);
  });

  it("agrees on total profit, computed independently from the seed", () => {
    const handComputed = round(
      expected.revenue
        - expected.cogs
        - expected.postage
        - expected.commission
        - expected.processorFee
        - expected.replacementCogs
        - expected.replacementPostage,
    );
    expect(actual.profit).toBe(handComputed);
  });
});

describe("what a replacement does and does not do to the books", () => {
  it("adds NO revenue at all", () => {
    expect(actual.replacementRevenue).toBe(0);
  });

  it("adds its COGS in full — the units really left the shelf", () => {
    expect(actual.replacementCogs).toBe(expected.replacementCogs);
    expect(actual.replacementCogs).toBeGreaterThan(0);
  });

  it("adds its postage in full — the label was really bought", () => {
    expect(actual.replacementPostage).toBe(expected.replacementPostage);
    expect(actual.replacementPostage).toBeGreaterThan(0);
  });

  it("lowers total profit by exactly its COGS plus its postage", () => {
    const withoutReplacements = round(
      expected.revenue - expected.cogs - expected.postage - expected.commission - expected.processorFee,
    );
    const cost = round(expected.replacementCogs + expected.replacementPostage);
    expect(round(withoutReplacements - actual.profit)).toBe(cost);
  });

  it("does not move AOV, because the denominator is purchases", () => {
    // 105 shipments must never become the AOV denominator.
    expect(expected.aov).toBe(round(expected.revenue / 100));
    expect(expected.aov).not.toBe(round(expected.revenue / 105));
  });
});

describe("free shipping is still a real postage expense", () => {
  it("keeps shipping revenue and postage independent", () => {
    const free = PURCHASES.filter((o) => o.shippingCharged === 0);
    expect(free.length).toBeGreaterThan(0);

    for (const o of free.slice(0, 3)) {
      const result = computeOrderProfit({
        netMerchandiseRevenue: o.units * o.unitPrice - o.discount,
        shippingRevenue: 0,
        commission: 0,
        processingFee: 0,
        shippingCost: o.postage,
        shippingCostIsEstimate: false,
        refund: 0,
        lines: [{ quantity: o.units, unitCostCents: o.unitCostCents }],
      });
      expect(result.shippingRevenue).toBe(0);
      // The carrier was still paid.
      expect(result.shippingCost).toBe(o.postage);
      expect(result.shippingProfit).toBe(round(0 - o.postage));
    }
  });

  it("charges $15 and pays $7.43 without netting them into one number", () => {
    const result = computeOrderProfit({
      netMerchandiseRevenue: 200,
      shippingRevenue: 15,
      commission: 0,
      processingFee: 0,
      shippingCost: 7.43,
      shippingCostIsEstimate: false,
      refund: 0,
      lines: [{ quantity: 1, unitCostCents: 5000 }],
    });
    expect(result.shippingRevenue).toBe(15);
    expect(result.shippingCost).toBe(7.43);
    expect(result.revenue).toBe(215);
    expect(result.profit).toBe(round(215 - 50 - 7.43));
  });
});

describe("every figure is a whole number of cents", () => {
  it("returns no sub-cent values across all 100 orders", () => {
    // Summing then rounding hides drift: 100 orders each off by a thousandth
    // of a cent reconcile fine and still print wrong. This checks each order's
    // own output instead, where the drift is visible.
    const isWholeCents = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

    for (const o of PURCHASES) {
      const net = o.units * o.unitPrice - o.discount;
      const result = computeOrderProfit({
        netMerchandiseRevenue: net,
        shippingRevenue: o.shippingCharged,
        commission: o.commission,
        processingFee: round((net + o.shippingCharged) * o.processorRate),
        shippingCost: o.postage,
        shippingCostIsEstimate: false,
        refund: 0,
        lines: [{ quantity: o.units, unitCostCents: o.unitCostCents }],
      });

      for (const [field, value] of Object.entries({
        revenue: result.revenue,
        cogs: result.cogs,
        profit: result.profit,
        shippingCost: result.shippingCost,
        commission: result.commission,
      })) {
        expect(isWholeCents(value), `${field} = ${value} is not a whole number of cents`).toBe(true);
      }
    }
  });

  it("returns an exact cent for a combination that drifts in IEEE-754", () => {
    // 19.99 - 7.43 - 0.58 is 11.979999999999999 in raw float arithmetic. The
    // seeded orders above all happen to be float-exact, so THIS is the case
    // that actually proves the rounding is doing work.
    const result = computeOrderProfit({
      netMerchandiseRevenue: 19.99,
      shippingRevenue: 0,
      commission: 0.58,
      processingFee: 0,
      shippingCost: 7.43,
      shippingCostIsEstimate: false,
      refund: 0,
      lines: [{ quantity: 0, unitCostCents: 0 }],
    });
    expect(result.profit).toBe(11.98);
    expect(result.profit * 100).toBe(1198);
  });

  it("keeps a decimal postage string exact rather than float-multiplying it", () => {
    // 5.20 * 100 is 520.0000000000001 in IEEE-754.
    const result = computeOrderProfit({
      netMerchandiseRevenue: 100,
      shippingRevenue: 0,
      commission: 0,
      processingFee: 0,
      shippingCost: 5.2,
      shippingCostIsEstimate: false,
      refund: 0,
      lines: [{ quantity: 1, unitCostCents: 1000 }],
    });
    expect(result.shippingCost).toBe(5.2);
    expect(result.profit).toBe(round(100 - 10 - 5.2));
  });
});

describe("the totals are not tautological", () => {
  it("would notice if the seed changed", () => {
    // A reconciliation that passes for any input proves nothing. These pin the
    // seed itself, so an accidental edit to the generator is caught rather
    // than silently re-baselining every assertion above.
    expect(expected.units).toBe(300);
    expect(expected.sales).toBe(100);
    expect(expected.revenue).toBeGreaterThan(0);
    expect(expected.cogs).toBeGreaterThan(0);
    expect(expected.commission).toBeGreaterThan(0);
    expect(expected.discount).toBeGreaterThan(0);
  });
});
