import { describe, expect, it } from "vitest";
import { computeOrderProfit, type OrderProfitInput } from "./order-profit";

function base(over: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    netMerchandiseRevenue: 100,
    shippingRevenue: 0,
    shippingCost: 0,
    lines: [{ unitCostCents: 3000, quantity: 1 }],
    commission: 0,
    processingFee: 0,
    refund: 0,
    ...over,
  };
}

describe("computeOrderProfit", () => {
  it("basic: revenue − COGS − commission − fee", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 2614, quantity: 1 }],
      commission: 10,
      processingFee: 5,
    }));
    expect(r.cogs).toBe(26.14);
    expect(r.profit).toBe(58.86); // 100 − 26.14 − 10 − 5
    expect(r.marginPercent).toBe(58.86);
  });

  it("quantities multiply the snapshot cost", () => {
    const r = computeOrderProfit(base({ netMerchandiseRevenue: 300, lines: [{ unitCostCents: 3000, quantity: 3 }] }));
    expect(r.cogs).toBe(90);
    expect(r.profit).toBe(210);
  });

  it("HISTORICAL ACCURACY: uses the snapshotted cost, not a new one", () => {
    const july = computeOrderProfit(base({ netMerchandiseRevenue: 65, lines: [{ unitCostCents: 2400, quantity: 1 }] }));
    expect(july.profit).toBe(41);
    const august = computeOrderProfit(base({ netMerchandiseRevenue: 65, lines: [{ unitCostCents: 3100, quantity: 1 }] }));
    expect(august.profit).toBe(34);
  });

  it("FREE shipping subtracts the $10 shipping cost (no shipping revenue)", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 260,
      lines: [{ unitCostCents: 3000, quantity: 4 }], // $120 COGS
      shippingRevenue: 0,
      shippingCost: 10,
    }));
    expect(r.profit).toBe(130); // 260 − 120 − 10
    expect(r.shippingRevenue).toBe(0);
    expect(r.shippingCost).toBe(10);
  });

  it("PAID shipping adds the shipping revenue and subtracts the $10 cost", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 3000, quantity: 1 }],
      shippingRevenue: 15, // customer paid $15 shipping
      shippingCost: 10,
    }));
    // 100 + 15 − 30 − 10 = 75
    expect(r.revenue).toBe(115);
    expect(r.profit).toBe(75);
  });

  it("commission, processing fee, free shipping all stack correctly", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 200,
      lines: [{ unitCostCents: 3000, quantity: 2 }], // $60
      commission: 20,
      processingFee: 6,
      shippingRevenue: 0,
      shippingCost: 10,
    }));
    expect(r.profit).toBe(104); // 200 − 60 − 20 − 6 − 10
  });

  it("a refund reduces net revenue and profit", () => {
    const r = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: 3000, quantity: 1 }], refund: 40 }));
    expect(r.revenue).toBe(60);
    expect(r.profit).toBe(30);
  });

  it("missing snapshot falls back to worst-case and flags the estimate", () => {
    const r = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: null, quantity: 1 }], fallbackUnitCostCents: 3500 }));
    expect(r.cogs).toBe(35);
    expect(r.hasEstimatedCost).toBe(true);
    expect(r.profit).toBe(65);
  });

  it("no divide-by-zero on a fully refunded order; loss = costs", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 3000, quantity: 1 }],
      shippingCost: 10,
      refund: 100,
    }));
    expect(r.revenue).toBe(0);
    // NOT 0%. A $40 loss beside "0.0%" reads as having broken even; a margin is
    // a proportion of revenue and there is none here. See
    // margin-never-flatters-a-loss.test.ts.
    expect(r.marginPercent).toBeNull();
    expect(r.profit).toBe(-40); // −COGS − shippingCost
  });

  it("negative inputs are clamped (can't inflate profit)", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: -500, quantity: 2 }],
      commission: -5, processingFee: -1, shippingCost: -2, refund: -10,
    }));
    expect(r.cogs).toBe(0);
    expect(r.commission).toBe(0);
    expect(r.profit).toBe(100);
  });

  it("shipping profit/loss is exposed for reporting", () => {
    const paid = computeOrderProfit(base({ shippingRevenue: 15, shippingCost: 6 }));
    expect(paid.shippingProfit).toBe(9); // 15 − 6
    const free = computeOrderProfit(base({ shippingRevenue: 0, shippingCost: 6 }));
    expect(free.shippingProfit).toBe(-6);
  });

  it("gross revenue excludes refunds; net revenue includes them", () => {
    const r = computeOrderProfit(base({ netMerchandiseRevenue: 200, shippingRevenue: 15, refund: 50 }));
    expect(r.grossRevenue).toBe(215);
    expect(r.revenue).toBe(165);
  });

  it("carries sales tax for display but never counts it as profit", () => {
    const withTax = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: 3000, quantity: 1 }], taxCollected: 8 }));
    const withoutTax = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: 3000, quantity: 1 }] }));
    expect(withTax.taxCollected).toBe(8);
    expect(withTax.profit).toBe(withoutTax.profit); // tax has zero effect on profit
  });

  it("profit is ESTIMATED until the exact shipping cost is known", () => {
    const estimate = computeOrderProfit(base({ shippingCost: 6, shippingCostIsEstimate: true }));
    expect(estimate.profitStatus).toBe("estimated");
    const exact = computeOrderProfit(base({ shippingCost: 7.25, shippingCostIsEstimate: false }));
    expect(exact.profitStatus).toBe("finalized");
  });

  it("a missing cost snapshot keeps profit ESTIMATED even with an exact shipping cost", () => {
    const r = computeOrderProfit(base({ lines: [{ unitCostCents: null, quantity: 1 }], fallbackUnitCostCents: 3300, shippingCostIsEstimate: false }));
    expect(r.hasEstimatedCost).toBe(true);
    expect(r.profitStatus).toBe("estimated");
  });

  it("builds an ordered expense ledger and total", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 200,
      lines: [{ unitCostCents: 3000, quantity: 2 }], // $60 COGS
      shippingCost: 6,
      processingFee: 16,
      commission: 20,
    }));
    expect(r.expenses.map((e) => e.key)).toEqual(["cogs", "shipping_cost", "processing_fee", "commission"]);
    expect(r.totalExpenses).toBe(102); // 60 + 6 + 16 + 20
    expect(r.profit).toBe(98); // 200 − 102
  });

  it("counts sales tax as profit only when countTaxAsProfit is set", () => {
    const excluded = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: 3000, quantity: 1 }], taxCollected: 8 }));
    const included = computeOrderProfit(base({ netMerchandiseRevenue: 100, lines: [{ unitCostCents: 3000, quantity: 1 }], taxCollected: 8, countTaxAsProfit: true }));
    expect(excluded.profit).toBe(70); // 100 − 30
    expect(excluded.taxCountedAsProfit).toBe(false);
    expect(included.profit).toBe(78); // 100 + 8 tax − 30
    expect(included.grossRevenue).toBe(108);
    expect(included.taxCountedAsProfit).toBe(true);
  });

  it("counts shipping protection / customer-paid fees as revenue", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 3000, quantity: 1 }], // $30
      additionalRevenue: 4, // 4% shipping protection on a $100 order
    }));
    expect(r.additionalRevenue).toBe(4);
    expect(r.grossRevenue).toBe(104);
    expect(r.profit).toBe(74); // 100 + 4 − 30
  });

  it("EXTENSIBILITY: extra expense line items reduce profit without engine changes", () => {
    const r = computeOrderProfit(base({
      netMerchandiseRevenue: 200,
      lines: [{ unitCostCents: 3000, quantity: 1 }], // $30
      extraExpenses: [
        { key: "ad_spend", label: "Advertising", amount: 12 },
        { key: "chargeback", label: "Chargeback fee", amount: 15, kind: "other" },
      ],
    }));
    expect(r.expenses.some((e) => e.key === "ad_spend")).toBe(true);
    expect(r.totalExpenses).toBe(57); // 30 + 12 + 15
    expect(r.profit).toBe(143); // 200 − 57
  });
});

// ===========================================================================
// AN ESTIMATE MUST NEVER BE PRESENTED AS AN ACTUAL COST.
//
// The engine already did this correctly for shipping — "Shipping cost
// (estimated)" until the real label cost lands. It did NOT do it for the
// payment-processor fee, which is modelled from config.processingFeePercent and
// is therefore ALWAYS an estimate: nothing in this application ingests a
// settled per-transaction fee. The owner's order detail showed a plain
// "Payment processor fee" against a number no processor had ever quoted.
// ===========================================================================
describe("estimated costs are labelled as estimates", () => {
  const base = {
    netMerchandiseRevenue: 200,
    shippingRevenue: 15,
    shippingCost: 9.42,
    lines: [{ unitCostCents: 2000, quantity: 2 }],
    commission: 0,
    processingFee: 6.5,
    refund: 0,
  };

  it("defaults the processing fee to ESTIMATED — a forgetful caller under-claims", () => {
    const r = computeOrderProfit(base);
    expect(r.processingFeeIsEstimate).toBe(true);
    expect(r.expenses.find((e) => e.key === "processing_fee")?.label)
      .toBe("Payment processor fee (estimated)");
  });

  it("drops the qualifier only when a settled fee is supplied", () => {
    const r = computeOrderProfit({ ...base, processingFeeIsEstimate: false });
    expect(r.processingFeeIsEstimate).toBe(false);
    expect(r.expenses.find((e) => e.key === "processing_fee")?.label)
      .toBe("Payment processor fee");
  });

  it("labels shipping the same way, in both directions", () => {
    expect(computeOrderProfit({ ...base, shippingCostIsEstimate: true })
      .expenses.find((e) => e.key === "shipping_cost")?.label).toBe("Shipping cost (estimated)");
    expect(computeOrderProfit({ ...base, shippingCostIsEstimate: false })
      .expenses.find((e) => e.key === "shipping_cost")?.label).toBe("Shipping cost");
  });

  it("labelling changes the words, never the arithmetic", () => {
    const est = computeOrderProfit({ ...base, processingFeeIsEstimate: true });
    const act = computeOrderProfit({ ...base, processingFeeIsEstimate: false });
    expect(est.profit).toBe(act.profit);
    expect(est.totalExpenses).toBe(act.totalExpenses);
  });

  it("finalized still means shipping+COGS exact, not fee exact", () => {
    // Otherwise no order could ever finalize and the flag would say nothing.
    const r = computeOrderProfit({ ...base, shippingCostIsEstimate: false });
    expect(r.profitStatus).toBe("finalized");
    expect(r.processingFeeIsEstimate).toBe(true);
  });
});

// ===========================================================================
// THE OWNER'S QUESTION: "EXACTLY HOW MUCH DID I MAKE ON THIS ORDER?"
//
// Every expected value below is computed BY HAND in the test, never by calling
// the engine — otherwise the test only proves the engine agrees with itself.
// ===========================================================================
describe("order economics, reconciled by hand", () => {
  it("a standard order", () => {
    // Products 200.00, discount 20.00, shipping charged 15.00.
    // COGS 2 x 20.00 = 40.00. Postage 9.42. Fee 6.50.
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.revenue).toBe(195);                    // 180 + 15
    expect(r.cogs).toBe(40);                        // 2 x 20
    expect(r.totalExpenses).toBe(55.92);            // 40 + 9.42 + 6.50
    expect(r.profit).toBe(139.08);                  // 195 − 55.92
    expect(r.marginPercent).toBe(71.32);            // 139.08 / 195
  });

  it("FREE SHIPPING — postage is still an expense the owner absorbs", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 0, shippingCost: 9.42,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.shippingRevenue).toBe(0);
    expect(r.shippingCost).toBe(9.42);
    // Shipping runs at a loss, and that loss is visible on its own.
    expect(r.shippingProfit).toBe(-9.42);
    expect(r.profit).toBe(124.08);                  // 180 − 40 − 9.42 − 6.50
  });

  it("shipping charged EXCEEDS postage — the surplus is real margin", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      lines: [], commission: 0, processingFee: 0, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.shippingProfit).toBe(5.58);            // 15.00 − 9.42
  });

  it("postage EXCEEDS shipping charged — the shortfall is real too", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 5, shippingCost: 12.4,
      lines: [], commission: 0, processingFee: 0, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.shippingProfit).toBe(-7.4);
  });

  it("a refund reverses revenue without erasing the costs already incurred", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 50, shippingCostIsEstimate: false,
    });
    expect(r.grossRevenue).toBe(195);
    expect(r.revenue).toBe(145);                    // 195 − 50
    // The parcel still shipped and the goods still left the shelf.
    expect(r.cogs).toBe(40);
    expect(r.shippingCost).toBe(9.42);
    expect(r.profit).toBe(89.08);                   // 145 − 55.92
  });

  it("an ambassador commission is a real expense", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 18, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.totalExpenses).toBe(73.92);            // 55.92 + 18
    expect(r.profit).toBe(121.08);
  });

  it("multi-item, multi-dose — each line uses its OWN snapshotted cost", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 300, shippingRevenue: 0, shippingCost: 11.06,
      lines: [
        { unitCostCents: 2000, quantity: 3 },   // 60.00
        { unitCostCents: 3500, quantity: 2 },   // 70.00
        { unitCostCents: 900, quantity: 1 },    //  9.00
      ],
      commission: 0, processingFee: 9, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.cogs).toBe(139);                       // 60 + 70 + 9
    expect(r.profit).toBe(140.94);                  // 300 − 139 − 11.06 − 9
  });

  it("sales tax is a pass-through, not earnings", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      taxCollected: 14.85,
      lines: [{ unitCostCents: 2000, quantity: 2 }],
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.taxCollected).toBe(14.85);
    expect(r.taxCountedAsProfit).toBe(false);
    // Identical to the standard order — the tax changed nothing.
    expect(r.profit).toBe(139.08);
  });

  it("a missing cost snapshot is flagged, never silently treated as free", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42,
      lines: [{ unitCostCents: null, quantity: 2 }],
      fallbackUnitCostCents: 2500,
      commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false,
    });
    expect(r.hasEstimatedCost).toBe(true);
    expect(r.cogs).toBe(50);                        // worst-case 25.00 x 2
    expect(r.profitStatus).toBe("estimated");       // cannot finalize on a guess
  });
});

// ===========================================================================
// ORDER-LEVEL ECONOMICS MUST SUM TO THE AGGREGATE.
// ===========================================================================
describe("aggregate reconciles to the sum of orders", () => {
  it("five different orders sum exactly", () => {
    const orders = [
      { netMerchandiseRevenue: 180, shippingRevenue: 15, shippingCost: 9.42, lines: [{ unitCostCents: 2000, quantity: 2 }], commission: 0, processingFee: 6.5, refund: 0, shippingCostIsEstimate: false },
      { netMerchandiseRevenue: 90,  shippingRevenue: 0,  shippingCost: 7.1,  lines: [{ unitCostCents: 1500, quantity: 1 }], commission: 0, processingFee: 3,   refund: 0, shippingCostIsEstimate: false },
      { netMerchandiseRevenue: 240, shippingRevenue: 15, shippingCost: 11.06, lines: [{ unitCostCents: 2000, quantity: 4 }], commission: 24, processingFee: 8, refund: 0, shippingCostIsEstimate: false },
      { netMerchandiseRevenue: 120, shippingRevenue: 15, shippingCost: 9.42, lines: [{ unitCostCents: 1000, quantity: 2 }], commission: 0, processingFee: 4.5, refund: 40, shippingCostIsEstimate: false },
      { netMerchandiseRevenue: 60,  shippingRevenue: 0,  shippingCost: 6.2,  lines: [{ unitCostCents: 900,  quantity: 1 }], commission: 0, processingFee: 2,   refund: 0, shippingCostIsEstimate: false },
    ];
    const results = orders.map(computeOrderProfit);

    // Independently: revenue = merch + shipping − refund, per order.
    const expectedRevenue = (180 + 15) + (90 + 0) + (240 + 15) + (120 + 15 - 40) + (60 + 0);
    const expectedCogs = 40 + 15 + 80 + 20 + 9;
    const expectedPostage = 9.42 + 7.1 + 11.06 + 9.42 + 6.2;
    const expectedFees = 6.5 + 3 + 8 + 4.5 + 2;
    const expectedCommission = 24;
    const expectedProfit =
      expectedRevenue - expectedCogs - expectedPostage - expectedFees - expectedCommission;

    const sum = (pick: (r: ReturnType<typeof computeOrderProfit>) => number) =>
      Math.round(results.reduce((t, r) => t + pick(r), 0) * 100) / 100;

    expect(sum((r) => r.revenue)).toBe(expectedRevenue);
    expect(sum((r) => r.cogs)).toBe(expectedCogs);
    expect(sum((r) => r.shippingCost)).toBe(Math.round(expectedPostage * 100) / 100);
    expect(sum((r) => r.processingFee)).toBe(expectedFees);
    expect(sum((r) => r.commission)).toBe(expectedCommission);
    expect(sum((r) => r.profit)).toBe(Math.round(expectedProfit * 100) / 100);
  });
});
