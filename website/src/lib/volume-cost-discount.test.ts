import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOLUME_COST_DISCOUNT_CONFIG,
  applyVolumeCostDiscountCents,
  applyVolumeCostDiscountDollars,
  describeVolumeCostDiscount,
  normalizeVolumeCostTiers,
  resolveVolumeCostDiscount,
  type VolumeCostDiscountConfig,
} from "@/lib/volume-cost-discount";

const config = DEFAULT_VOLUME_COST_DISCOUNT_CONFIG;

describe("volume cost discount — the agreed schedule", () => {
  it("gives no reduction below $5,000 of monthly sales", () => {
    expect(resolveVolumeCostDiscount(0, config).percent).toBe(0);
    expect(resolveVolumeCostDiscount(4999.99, config).percent).toBe(0);
  });

  it("gives 20% at exactly $5,000 and up to the next threshold", () => {
    expect(resolveVolumeCostDiscount(5000, config).percent).toBe(20);
    expect(resolveVolumeCostDiscount(7500, config).percent).toBe(20);
    expect(resolveVolumeCostDiscount(9999.99, config).percent).toBe(20);
  });

  it("gives 30% at exactly $10,000 and above", () => {
    expect(resolveVolumeCostDiscount(10000, config).percent).toBe(30);
    expect(resolveVolumeCostDiscount(250000, config).percent).toBe(30);
  });

  it("reports which tier applied, for the audit trail", () => {
    expect(resolveVolumeCostDiscount(12000, config).tier).toEqual({ minMonthlySales: 10000, costReductionPercent: 30 });
    expect(resolveVolumeCostDiscount(100, config).tier).toBeNull();
  });
});

describe("volume cost discount — resolution safety", () => {
  it("takes the HIGHEST qualifying tier even when tiers are entered out of order", () => {
    const jumbled: VolumeCostDiscountConfig = {
      enabled: true,
      tiers: [
        { minMonthlySales: 10000, costReductionPercent: 30 },
        { minMonthlySales: 5000, costReductionPercent: 20 },
      ],
    };
    expect(resolveVolumeCostDiscount(15000, jumbled).percent).toBe(30);
  });

  it("returns full cost when the program is switched off", () => {
    expect(resolveVolumeCostDiscount(50000, { enabled: false, tiers: config.tiers }).percent).toBe(0);
  });

  it("treats a negative or non-finite sales figure as zero sales, not as a tier", () => {
    expect(resolveVolumeCostDiscount(-1, config).percent).toBe(0);
    expect(resolveVolumeCostDiscount(Number.NaN, config).percent).toBe(0);
  });

  it("never lets a malformed tier become a free-cost tier", () => {
    // A row with no threshold and a 100% reduction is exactly the shape that
    // would zero out COGS on every order. It must be dropped, not honoured.
    const malformed = normalizeVolumeCostTiers([
      { costReductionPercent: 100 },
      { minMonthlySales: "abc", costReductionPercent: 50 },
      { minMonthlySales: 5000, costReductionPercent: 0 },
      { minMonthlySales: -100, costReductionPercent: 40 },
      null,
      "nope",
    ]);
    expect(malformed).toEqual([]);
  });

  it("clamps a reduction above 100% rather than producing negative cost", () => {
    const tiers = normalizeVolumeCostTiers([{ minMonthlySales: 5000, costReductionPercent: 150 }]);
    expect(tiers[0].costReductionPercent).toBe(100);
    expect(applyVolumeCostDiscountCents(1000, 150)).toBe(0);
  });

  it("accepts snake_case keys as stored by the control table", () => {
    expect(normalizeVolumeCostTiers([{ min_monthly_sales: 5000, cost_reduction_percent: 20 }])).toEqual([
      { minMonthlySales: 5000, costReductionPercent: 20 },
    ]);
  });

  it("falls back to the agreed schedule when the stored value is not a list", () => {
    expect(normalizeVolumeCostTiers(undefined)).toEqual([
      { minMonthlySales: 5000, costReductionPercent: 20 },
      { minMonthlySales: 10000, costReductionPercent: 30 },
    ]);
  });
});

describe("volume cost discount — applying it to a cost", () => {
  it("takes 20% and 30% off a unit cost, in cents", () => {
    expect(applyVolumeCostDiscountCents(3300, 20)).toBe(2640);
    expect(applyVolumeCostDiscountCents(3300, 30)).toBe(2310);
  });

  it("is an exact no-op at 0%", () => {
    expect(applyVolumeCostDiscountCents(3300, 0)).toBe(3300);
    expect(applyVolumeCostDiscountDollars(33, 0)).toBe(33);
  });

  it("keeps the dollars and cents paths in agreement", () => {
    for (const percent of [0, 20, 30]) {
      for (const costCents of [1, 999, 3300, 12345]) {
        const viaDollars = Math.round(applyVolumeCostDiscountDollars(costCents / 100, percent) * 100);
        expect(viaDollars).toBe(applyVolumeCostDiscountCents(costCents, percent));
      }
    }
  });

  it("never returns a negative cost", () => {
    expect(applyVolumeCostDiscountCents(-500, 20)).toBe(0);
    expect(applyVolumeCostDiscountDollars(-5, 20)).toBe(0);
  });
});

describe("volume cost discount — admin label", () => {
  it("names the tier that is earning the reduction", () => {
    expect(describeVolumeCostDiscount(resolveVolumeCostDiscount(12000, config))).toBe("30% off cost ($10,000+/mo)");
    expect(describeVolumeCostDiscount(resolveVolumeCostDiscount(6000, config))).toBe("20% off cost ($5,000+/mo)");
  });

  it("says so plainly when no tier is earned", () => {
    expect(describeVolumeCostDiscount(resolveVolumeCostDiscount(100, config))).toBe("No volume tier earned yet");
  });
});
