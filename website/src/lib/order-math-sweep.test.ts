import { describe, expect, it, vi } from "vitest";

// vitest.setup.ts globally mocks @/lib/coupons (stubbing calculateCouponDiscount
// to 0) so the server-only chain loads for the payment tests. Undo it here so
// the sweep exercises the REAL coupon math. Hoisted above imports like vi.mock.
vi.unmock("@/lib/coupons");

import { calculateShipping, calculateHandlingFee, calculateTax, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { calculateBulkSavingsDiscount, DEFAULT_BULK_SAVINGS_CONFIG } from "@/lib/bulk-savings";
import { resolveBestDiscount, type DiscountCandidate } from "@/lib/discount-resolution";
import { calculateDiscountAmount, calculateCommissionAmount } from "@/lib/referral-service";
import { calculateCouponDiscount } from "@/lib/coupons";
import { pointsToDollars, dollarsToPoints, calculateEarnedPoints } from "@/lib/points-math";
import { bundleDiscountRate, getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";

function round(v: number) {
  return Math.round(v * 100) / 100;
}

// Mirrors the order-total composition in payment-service.ts using the SAME pure
// functions the live checkout uses, so this sweep exercises the real math.
function computeOrder(o: {
  subtotal: number;
  referral: boolean;
  memberPercent: number;
  memberFreeShip: boolean;
  bulkEligible: boolean;
  couponFixed: number;
  country: string;
  taxPercent: number;
  commissionPercent: number;
}) {
  const bulk = calculateBulkSavingsDiscount(o.subtotal, o.bulkEligible, DEFAULT_BULK_SAVINGS_CONFIG);
  const referralDisc = o.referral ? calculateDiscountAmount(o.subtotal, 10) : 0;
  const memberDisc = o.memberPercent > 0 ? calculateDiscountAmount(o.subtotal, o.memberPercent) : 0;
  const couponDisc = o.couponFixed > 0 ? calculateCouponDiscount(o.subtotal, "fixed", o.couponFixed) : 0;

  const candidates: DiscountCandidate[] = [
    { type: "bulk_savings", amount: bulk.amount },
    { type: "member_pricing", amount: memberDisc },
    { type: "referral", amount: referralDisc },
    { type: "coupon", amount: couponDisc },
  ];
  const best = resolveBestDiscount(candidates);
  const discount = round(best?.amount ?? 0);

  const discountedSubtotal = Math.max(0, round(o.subtotal - discount));
  const tax = calculateTax(discountedSubtotal, o.taxPercent);
  const handling = calculateHandlingFee(o.subtotal, DEFAULT_SHIPPING_CONFIG);
  const freeShip = bulk.tier !== null || o.memberFreeShip;
  const shipping = freeShip ? 0 : calculateShipping(o.subtotal, o.country, DEFAULT_SHIPPING_CONFIG);
  const total = round(o.subtotal + shipping + handling + tax - discount);
  const commission = o.referral ? calculateCommissionAmount(discountedSubtotal, o.commissionPercent) : 0;

  return { discount, discountType: best?.type ?? null, discountedSubtotal, tax, handling, shipping, total, commission, candidates };
}

// ─── EXHAUSTIVE ORDER-MATH SWEEP ───────────────────────────────────────────
describe("order-math sweep: core invariants hold across every combination", () => {
  const subtotals = [0, 25, 55, 99, 100, 150, 250, 260, 500, 1000, 3000];
  const bools = [false, true];
  const memberPercents = [0, 10, 15, 25];
  const coupons = [0, 5, 25, 100, 5000]; // incl. absurdly large coupon
  const countries = ["United States", "Canada", ""];
  const taxRates = [0, 7, 10];
  const commissionRates = [10, 15, 20];

  let scenarios = 0;

  it("never negative, never over-discounted, one discount, commission on discounted subtotal only", () => {
    for (const subtotal of subtotals) {
      for (const referral of bools) {
        for (const memberPercent of memberPercents) {
          for (const bulkEligible of bools) {
            for (const couponFixed of coupons) {
              for (const country of countries) {
                for (const taxPercent of taxRates) {
                  for (const commissionPercent of commissionRates) {
                    scenarios += 1;
                    const r = computeOrder({ subtotal, referral, memberPercent, memberFreeShip: false, bulkEligible, couponFixed, country, taxPercent, commissionPercent });
                    const ctx = () => JSON.stringify({ subtotal, referral, memberPercent, bulkEligible, couponFixed, country, taxPercent, commissionPercent });

                    // 1. A discount can never exceed the subtotal.
                    expect(r.discount, `discount > subtotal for ${ctx()}`).toBeLessThanOrEqual(subtotal + 0.001);
                    // 2. No customer ever pays a negative total.
                    expect(r.total, `negative total for ${ctx()}`).toBeGreaterThanOrEqual(0);
                    // 3. Only ONE discount is applied — its amount equals the single largest candidate.
                    const maxCandidate = Math.max(0, ...r.candidates.map((c) => c.amount));
                    expect(round(r.discount)).toBe(round(maxCandidate));
                    // 4. Tax is charged on the post-discount merchandise only (never shipping/handling).
                    expect(r.tax).toBe(calculateTax(r.discountedSubtotal, taxPercent));
                    // 5. Commission (when a code is used) is on the discounted subtotal, before tax — never on tax/shipping.
                    if (referral) {
                      expect(r.commission).toBe(calculateCommissionAmount(r.discountedSubtotal, commissionPercent));
                      expect(r.commission).toBeLessThanOrEqual(r.discountedSubtotal + 0.001);
                    } else {
                      expect(r.commission).toBe(0);
                    }
                    // 6. Free shipping at/above the domestic threshold.
                    if (!bulkEligible && country !== "Canada" && subtotal >= DEFAULT_SHIPPING_CONFIG.freeShippingThreshold) {
                      expect(r.shipping).toBe(0);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(scenarios).toBeGreaterThan(5000);
  });
});

// ─── EDGE CASES: try to break each pure function ───────────────────────────
describe("shipping / tax / handling edge cases", () => {
  it("no shipping/handling/tax on a zero or negative subtotal", () => {
    expect(calculateShipping(0, "United States")).toBe(0);
    expect(calculateShipping(-50, "United States")).toBe(0);
    expect(calculateHandlingFee(0)).toBe(0);
    expect(calculateTax(0, 7)).toBe(0);
    expect(calculateTax(-100, 7)).toBe(0);
  });
  it("free shipping exactly at the threshold, charged one cent below", () => {
    expect(calculateShipping(250, "United States")).toBe(0);
    expect(calculateShipping(249.99, "United States")).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
  });
  it("international rates apply for non-domestic countries", () => {
    expect(calculateShipping(100, "Canada")).toBe(DEFAULT_SHIPPING_CONFIG.internationalFee);
    expect(calculateShipping(600, "Canada")).toBe(0);
  });
  it("tax ignores a zero/negative rate", () => {
    expect(calculateTax(100, 0)).toBe(0);
    expect(calculateTax(100, -5)).toBe(0);
    expect(calculateTax(100, 7)).toBe(7);
  });
});

describe("coupon math can't overspend or go negative", () => {
  it("a fixed coupon larger than the subtotal is capped at the subtotal", () => {
    expect(calculateCouponDiscount(50, "fixed", 500)).toBe(50);
  });
  it("a percent coupon over 100% is capped at the subtotal", () => {
    expect(calculateCouponDiscount(80, "percent", 250)).toBe(80);
  });
  it("zero/negative inputs yield no discount", () => {
    expect(calculateCouponDiscount(0, "fixed", 20)).toBe(0);
    expect(calculateCouponDiscount(100, "fixed", -20)).toBe(0);
    expect(calculateCouponDiscount(-10, "percent", 50)).toBe(0);
  });
});

describe("points math is non-negative and round-trips sanely", () => {
  it("100 points = $1, and dollars↔points is stable", () => {
    expect(pointsToDollars(100)).toBe(1);
    expect(dollarsToPoints(1)).toBe(100);
    expect(pointsToDollars(dollarsToPoints(3.5))).toBe(3.5);
  });
  it("never returns negative points", () => {
    expect(dollarsToPoints(-5)).toBe(0);
    expect(pointsToDollars(-100)).toBe(-1); // pointsToDollars is a straight conversion
    expect(calculateEarnedPoints(-50, 2, 1)).toBe(0);
    expect(calculateEarnedPoints(100, 2, 1)).toBe(200);
  });
});

describe("bundle pricing tiers", () => {
  it("applies the right rate per quantity", () => {
    expect(bundleDiscountRate(1)).toBe(0);
    expect(bundleDiscountRate(2)).toBe(0.05);
    expect(bundleDiscountRate(3)).toBe(0.08);
    expect(bundleDiscountRate(10)).toBe(0.20);
  });
  it("discounted line total is never above the undiscounted one", () => {
    for (let qty = 1; qty <= 12; qty += 1) {
      const undiscounted = round(65 * qty);
      expect(getBundleDiscountedLineTotal(65, qty)).toBeLessThanOrEqual(undiscounted);
    }
  });
});

describe("bulk savings tiers", () => {
  const cfg = DEFAULT_BULK_SAVINGS_CONFIG;
  it("no discount when not eligible, regardless of subtotal", () => {
    expect(calculateBulkSavingsDiscount(5000, false, cfg).amount).toBe(0);
  });
  it("applies tier1 then tier2 at their thresholds when eligible", () => {
    expect(calculateBulkSavingsDiscount(cfg.tier1Threshold - 1, true, cfg).tier).toBeNull();
    expect(calculateBulkSavingsDiscount(cfg.tier1Threshold, true, cfg).percent).toBe(cfg.tier1Percent);
    expect(calculateBulkSavingsDiscount(cfg.tier2Threshold, true, cfg).percent).toBe(cfg.tier2Percent);
  });
});
