import { describe, expect, it } from "vitest";
import { calculateShippingProtectionFee, DEFAULT_SHIPPING_PROTECTION_CONFIG } from "@/lib/shipping-protection";

describe("calculateShippingProtectionFee (tiered add-on)", () => {
  const { baseFee, midFee, highFee, midThreshold, highThreshold } = DEFAULT_SHIPPING_PROTECTION_CONFIG;

  it("charges nothing for an empty cart", () => {
    expect(calculateShippingProtectionFee(0)).toBe(0);
    expect(calculateShippingProtectionFee(-10)).toBe(0);
  });

  it("uses the base fee under the mid threshold", () => {
    expect(calculateShippingProtectionFee(50)).toBe(baseFee);
    expect(calculateShippingProtectionFee(midThreshold - 0.01)).toBe(baseFee);
  });

  it("uses the mid fee from the mid threshold up to the high threshold", () => {
    expect(calculateShippingProtectionFee(midThreshold)).toBe(midFee);
    expect(calculateShippingProtectionFee(300)).toBe(midFee);
    expect(calculateShippingProtectionFee(highThreshold - 0.01)).toBe(midFee);
  });

  it("uses the high fee at/above the high threshold", () => {
    expect(calculateShippingProtectionFee(highThreshold)).toBe(highFee);
    expect(calculateShippingProtectionFee(1000)).toBe(highFee);
  });

  it("is monotonically non-decreasing in subtotal", () => {
    let prev = 0;
    for (let s = 1; s <= 1000; s += 7) {
      const fee = calculateShippingProtectionFee(s);
      expect(fee).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = fee;
    }
  });
});
