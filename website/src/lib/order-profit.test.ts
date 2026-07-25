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
});
