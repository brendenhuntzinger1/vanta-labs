import { describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks this module globally (payment-service.test.ts /
// payment-webhook.test.ts transitively import it and can't load the real
// "server-only" version) - undo that here so the real math is exercised.
// Vitest hoists vi.unmock calls above imports, same as vi.mock.
vi.unmock("@/lib/coupons");

import { calculateCouponDiscount, normalizeCouponCode } from "@/lib/coupons";

describe("coupons", () => {
  it("normalizes codes for lookup", () => {
    expect(normalizeCouponCode("  save 10! ")).toBe("SAVE10");
  });

  it("applies a percent discount", () => {
    expect(calculateCouponDiscount(100, "percent", 10)).toBe(10);
  });

  it("applies a fixed discount", () => {
    expect(calculateCouponDiscount(100, "fixed", 15)).toBe(15);
  });

  it("never discounts more than the subtotal", () => {
    expect(calculateCouponDiscount(10, "fixed", 50)).toBe(10);
  });

  it("returns 0 for a non-positive subtotal or discount value", () => {
    expect(calculateCouponDiscount(0, "percent", 10)).toBe(0);
    expect(calculateCouponDiscount(100, "percent", 0)).toBe(0);
  });

  it("never returns a negative discount", () => {
    expect(calculateCouponDiscount(100, "fixed", -5)).toBe(0);
  });
});
