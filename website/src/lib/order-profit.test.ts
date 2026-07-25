import { describe, expect, it } from "vitest";
import { computeOrderProfit } from "./order-profit";

describe("computeOrderProfit", () => {
  it("basic profit: revenue − COGS − commission − fee − shipping", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 2614, quantity: 1 }], // $26.14 cost
      commission: 10,
      processingFee: 5,
      shippingCost: 0,
      refund: 0,
    });
    expect(r.cogs).toBe(26.14);
    expect(r.profit).toBe(58.86); // 100 − 26.14 − 10 − 5
    expect(r.marginPercent).toBe(58.86);
  });

  it("multiple quantities multiply the snapshot cost", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 300,
      lines: [{ unitCostCents: 3000, quantity: 3 }], // 3 × $30
      commission: 0,
      processingFee: 0,
      shippingCost: 0,
      refund: 0,
    });
    expect(r.cogs).toBe(90);
    expect(r.profit).toBe(210);
  });

  it("HISTORICAL ACCURACY: uses the snapshotted cost, not a new one", () => {
    // July order snapshotted $24; a later cost change to $31 must NOT affect it.
    const july = computeOrderProfit({
      netMerchandiseRevenue: 65,
      lines: [{ unitCostCents: 2400, quantity: 1 }],
      commission: 0, processingFee: 0, shippingCost: 0, refund: 0,
    });
    expect(july.cogs).toBe(24);
    expect(july.profit).toBe(41);

    const august = computeOrderProfit({
      netMerchandiseRevenue: 65,
      lines: [{ unitCostCents: 3100, quantity: 1 }],
      commission: 0, processingFee: 0, shippingCost: 0, refund: 0,
    });
    expect(august.cogs).toBe(31);
    expect(august.profit).toBe(34);
  });

  it("free shipping the store absorbed reduces profit", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 260,
      lines: [{ unitCostCents: 3000, quantity: 4 }], // $120 COGS
      commission: 0, processingFee: 0,
      shippingCost: 9, // store paid USPS on a free-shipping order
      refund: 0,
    });
    expect(r.profit).toBe(131); // 260 − 120 − 9
  });

  it("a refund reduces net revenue and profit", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 3000, quantity: 1 }],
      commission: 0, processingFee: 0, shippingCost: 0,
      refund: 40,
    });
    expect(r.revenue).toBe(60);
    expect(r.profit).toBe(30); // 60 − 30
  });

  it("missing snapshot falls back to worst-case and flags the estimate", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: null, quantity: 1 }],
      commission: 0, processingFee: 0, shippingCost: 0, refund: 0,
      fallbackUnitCostCents: 3500,
    });
    expect(r.cogs).toBe(35);
    expect(r.hasEstimatedCost).toBe(true);
    expect(r.profit).toBe(65);
  });

  it("never divides by zero on a fully refunded / zero-revenue order", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: 3000, quantity: 1 }],
      commission: 0, processingFee: 0, shippingCost: 0,
      refund: 100,
    });
    expect(r.revenue).toBe(0);
    expect(r.marginPercent).toBe(0);
    expect(r.profit).toBe(-30); // still owe the COGS
  });

  it("negative-ish inputs are clamped (no negative COGS/fees inflating profit)", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      lines: [{ unitCostCents: -500, quantity: 2 }],
      commission: -5, processingFee: -1, shippingCost: -2, refund: -10,
    });
    expect(r.cogs).toBe(0);
    expect(r.commission).toBe(0);
    expect(r.profit).toBe(100);
  });
});
