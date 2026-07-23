import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUNDLE_CONFIG,
  bundleDiscountRate,
  getBundleDiscountedUnitPrice,
  getBundleDiscountedLineTotal,
  resolveBundleConfig,
} from "@/lib/bundle-pricing";

describe("bundleDiscountRate defaults (unchanged behavior)", () => {
  it("keeps the original 0% / 5% / 8% curve when no config is passed", () => {
    expect(bundleDiscountRate(1)).toBe(0);
    expect(bundleDiscountRate(2)).toBe(0.05);
    expect(bundleDiscountRate(3)).toBe(0.08);
    expect(bundleDiscountRate(10)).toBe(0.08);
  });
});

describe("bundleDiscountRate with admin config", () => {
  const config = { twoUnitPercent: 0.1, threePlusPercent: 0.15 };
  it("applies the configured rates at the right thresholds", () => {
    expect(bundleDiscountRate(1, config)).toBe(0);
    expect(bundleDiscountRate(2, config)).toBe(0.1);
    expect(bundleDiscountRate(3, config)).toBe(0.15);
  });

  it("flows through unit and line-total helpers", () => {
    expect(getBundleDiscountedUnitPrice(100, 2, config)).toBe(90);
    expect(getBundleDiscountedLineTotal(100, 2, config)).toBe(180);
    expect(getBundleDiscountedLineTotal(100, 3, config)).toBe(255);
  });
});

describe("resolveBundleConfig (admin whole-number percents -> rates)", () => {
  it("converts percents to fractional rates", () => {
    expect(resolveBundleConfig({ twoUnitPercent: 5, threePlusPercent: 8 })).toEqual({
      twoUnitPercent: 0.05,
      threePlusPercent: 0.08,
    });
  });

  it("falls back to defaults on blank/invalid input", () => {
    expect(resolveBundleConfig({})).toEqual(DEFAULT_BUNDLE_CONFIG);
    expect(resolveBundleConfig({ twoUnitPercent: "", threePlusPercent: "abc" })).toEqual(DEFAULT_BUNDLE_CONFIG);
    expect(resolveBundleConfig({ twoUnitPercent: -3, threePlusPercent: 8 })).toEqual({
      twoUnitPercent: DEFAULT_BUNDLE_CONFIG.twoUnitPercent,
      threePlusPercent: 0.08,
    });
  });

  it("clamps an unreasonably large percent to 90%", () => {
    expect(resolveBundleConfig({ twoUnitPercent: 999, threePlusPercent: 999 })).toEqual({
      twoUnitPercent: 0.9,
      threePlusPercent: 0.9,
    });
  });
});
