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
    expect(r.marginPercent).toBe(0);
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
