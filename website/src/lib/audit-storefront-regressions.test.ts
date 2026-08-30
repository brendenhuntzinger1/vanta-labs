import { describe, expect, it } from "vitest";

import { clampPercent } from "@/lib/admin-control";
import { calculateCouponDiscount } from "@/lib/coupons";
import { resolveAllowedQuantity } from "@/app/api/cart/validate/route";

// ---------------------------------------------------------------------------
// Regressions found in the storefront audit. Each one is a case the existing
// suite did not have, not a restatement of one it did.
// ---------------------------------------------------------------------------

describe("the welcome offer's percent is a percent", () => {
  // A coupons ROW cannot hold a percent above 100 — createCoupon and
  // updateCoupon both reject it. The welcome offer is a VIRTUAL coupon
  // assembled from a control snapshot, so the only possible gate was
  // clampPercent — which lived in the same file, guarded every referral and
  // commission percent, and was not applied here.
  it("refuses a figure outside 0..100 and keeps the coded default", () => {
    expect(clampPercent(150, 10)).toBe(10);
    expect(clampPercent(1000, 10)).toBe(10);
    expect(clampPercent(-5, 10)).toBe(10);
  });

  it("accepts a figure that is genuinely a percent", () => {
    expect(clampPercent(15, 10)).toBe(15);
    expect(clampPercent(100, 10)).toBe(100);
    expect(clampPercent(0, 10)).toBe(0);
  });

  it("falls back for anything unreadable rather than coercing it", () => {
    for (const bad of [undefined, null, "", "abc", NaN, Infinity]) {
      expect(clampPercent(bad, 10), `input: ${String(bad)}`).toBe(10);
    }
  });

  it("keeps a typed extra zero from zeroing a first order's merchandise", () => {
    // What the old read did with "100" typed where "10" was meant: 100% off
    // the merchandise subtotal for every first-time customer — which the
    // profit floor then refuses outright, so the storefront advertises a code
    // whose own checkout answers "Promotion unavailable on this order."
    const subtotal = 200;
    expect(calculateCouponDiscount(subtotal, "percent", 150)).toBe(subtotal);
    expect(calculateCouponDiscount(subtotal, "percent", clampPercent(150, 10))).toBe(20);
  });
});

describe("a coupon amount never exceeds what is being bought", () => {
  it("caps a fixed code larger than the basket at the basket", () => {
    expect(calculateCouponDiscount(30, "fixed", 50)).toBe(30);
  });

  it("is zero on an empty or negative basket", () => {
    expect(calculateCouponDiscount(0, "percent", 20)).toBe(0);
    expect(calculateCouponDiscount(-10, "fixed", 5)).toBe(0);
  });
});

describe("cart validation publishes no more than the catalogue already does", () => {
  it("never returns a number above the per-line order ceiling", () => {
    // The clamp that stops {"quantity": 999999} reading the live count back.
    expect(resolveAllowedQuantity(999_999, 5_000)).toBeLessThanOrEqual(99);
  });

  it("answers 0 for a sold-out line and never a negative", () => {
    expect(resolveAllowedQuantity(3, 0)).toBe(0);
    expect(resolveAllowedQuantity(3, -7)).toBe(0);
  });

  it("leaves a satisfiable line at what was asked for", () => {
    expect(resolveAllowedQuantity(2, 10)).toBe(2);
  });
});
