import { describe, expect, it } from "vitest";
import { calculateShippingProtectionFee, SHIPPING_PROTECTION_PERCENT } from "@/lib/shipping-protection";

describe("calculateShippingProtectionFee (percentage add-on)", () => {
  it("charges nothing for an empty cart", () => {
    expect(calculateShippingProtectionFee(0)).toBe(0);
    expect(calculateShippingProtectionFee(-10)).toBe(0);
  });

  it("charges the configured percent of the merchandise subtotal", () => {
    expect(SHIPPING_PROTECTION_PERCENT).toBe(3);
    expect(calculateShippingProtectionFee(100)).toBe(3);
    expect(calculateShippingProtectionFee(50)).toBe(1.5);
    expect(calculateShippingProtectionFee(333.33)).toBe(10);
    expect(calculateShippingProtectionFee(1000)).toBe(30);
  });

  it("rounds to cents", () => {
    expect(calculateShippingProtectionFee(19.99)).toBe(0.6);
    expect(calculateShippingProtectionFee(66.66)).toBe(2);
  });

  it("scales with the subtotal — bigger orders pay a bigger fee", () => {
    let prev = 0;
    for (let s = 1; s <= 1000; s += 7) {
      const fee = calculateShippingProtectionFee(s);
      expect(fee).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = fee;
    }
    expect(calculateShippingProtectionFee(400)).toBeGreaterThan(calculateShippingProtectionFee(100));
  });

  it("a non-positive percent disables the fee", () => {
    expect(calculateShippingProtectionFee(100, 0)).toBe(0);
    expect(calculateShippingProtectionFee(100, -1)).toBe(0);
  });
});
