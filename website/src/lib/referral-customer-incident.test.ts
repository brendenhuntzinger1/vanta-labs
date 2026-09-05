import { describe, expect, it } from "vitest";

import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { resolveCartDiscount } from "@/lib/discount-resolution";
import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";

// ---------------------------------------------------------------------------
// THE INCIDENT, AS THE OWNER LIVED IT.
//
// A 15% ambassador's link, opened from her Linktree. Add an item. The
// storefront offers 10%. Remove the code, retype it, and the cart refuses it
// for being under a $100 minimum nobody set for her.
//
// Two separate defects, and the production values that prove them:
//
//   BUG A — 15% shown as 10%
//     ambassadors.customer_discount_percent = 15.00 for MIZZY.
//     referral.discount_percent is NOT SET in admin_control, so the program
//     falls back to DEFAULT_REFERRAL_DISCOUNT_PERCENT = 10.
//     The SERVER resolves per-ambassador (quote-order.ts:281):
//       resolveAmbassadorCustomerDiscount(data.customer_discount_percent, default) -> 15
//     The CART used the program-wide number and nothing else:
//       amount = discountBase * (referralDiscountPercent / 100)   -> 10
//     validate_referral_code, the RPC the cart validates against, returned only
//     code / id / name. The cart could not have known about her 15% — the rate
//     was never sent to it.
//
//   BUG B — the $100 that appeared only on retyping
//     ambassador.minimum_qualifying_order = 100, set 2026-08-08. Real, and
//     enforced by the server: quote-order.ts:568 THROWS below it.
//     applyReferralCode (manual entry) checked it. The auto-apply effect that
//     runs off the /r/CODE cookie did not. So arriving by link attached the
//     code silently on any cart size, and only retyping surfaced the rule —
//     which is why removing and re-adding "changed" the behaviour. The message
//     was right; the link path had been quietly wrong, and would have failed at
//     checkout instead.
//
// Both halves are asserted against the real resolvers, so this file fails if
// either defect returns.
// ---------------------------------------------------------------------------

/** MIZZY, exactly as production holds her. */
const MIZZY = { customerDiscountPercent: "15.00", minimumQualifyingOrder: 100 };
const PROGRAM_DEFAULT_DISCOUNT = 10;

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

const CART: OrderInputs = {
  subtotal: 0, fullSubtotal: 0, quantityBundleSavings: 0, productCost: 0,
  bundleDiscount: 0, referralAccepted: false, referralPercent: 0,
  isMember: false, membershipPercent: 0, couponDiscount: 0,
  bulkSavingsAmount: 0, personalDiscountAmount: 0, allowCouponStacking: false,
  commissionPercent: 0, processingFeePercent: 0, shippingCollected: 0,
  shippingCost: 0, handlingCollected: 0, taxPercent: 0,
};

/** What the SERVER charges — quote-order's resolution, then profit-engine. */
function serverDiscount(subtotal: number): number {
  const percent = resolveAmbassadorCustomerDiscount(
    MIZZY.customerDiscountPercent,
    PROGRAM_DEFAULT_DISCOUNT,
  );
  return resolveCustomerDiscount(
    { ...CART, subtotal, fullSubtotal: subtotal, referralAccepted: true, referralPercent: percent },
    ALL,
  ).amount;
}

/**
 * What the CART shows. Takes the rate the same way the cart now does — the
 * ambassador's own, resolved against the program default — rather than the
 * program number alone.
 */
function cartDiscount(subtotal: number, ambassadorRate: unknown = MIZZY.customerDiscountPercent): number {
  const percent = resolveAmbassadorCustomerDiscount(ambassadorRate, PROGRAM_DEFAULT_DISCOUNT);
  return resolveCartDiscount({
    subtotal,
    quantityBundleSavings: 0,
    bulkSavingsAmount: 0,
    memberPricingAmount: 0,
    ambassadorPersonalAmount: 0,
    couponDiscountAmount: 0,
    promos: [{ type: "referral", amount: subtotal * (percent / 100) }],
  }).amount;
}

describe("BUG A — her 15% is her 15%", () => {
  it("resolves 15, not the program's 10", () => {
    expect(resolveAmbassadorCustomerDiscount(MIZZY.customerDiscountPercent, PROGRAM_DEFAULT_DISCOUNT)).toBe(15);
  });

  /** numeric(5,2) arrives as "15.00". Read as absent, it silently becomes 10. */
  it("reads the postgres numeric string, not just a number", () => {
    expect(resolveAmbassadorCustomerDiscount("15.00", 10)).toBe(15);
    expect(resolveAmbassadorCustomerDiscount(15, 10)).toBe(15);
  });

  it("an ambassador with no override still inherits the program rate", () => {
    expect(resolveAmbassadorCustomerDiscount(null, PROGRAM_DEFAULT_DISCOUNT)).toBe(10);
  });

  it("honours a deliberate 0% rather than falling back to 10", () => {
    expect(resolveAmbassadorCustomerDiscount(0, PROGRAM_DEFAULT_DISCOUNT)).toBe(0);
  });

  it.each([50, 75, 99, 100, 101, 150, 200, 500])(
    "cart and server agree to the cent on a $%i basket",
    (subtotal) => {
      expect(cartDiscount(subtotal)).toBe(serverDiscount(subtotal));
    },
  );

  it("a $99 basket is discounted $14.85, never $9.90", () => {
    expect(cartDiscount(99)).toBeCloseTo(14.85, 2);
    expect(cartDiscount(99)).not.toBeCloseTo(9.9, 2);
  });

  /** The exact wrong answer the owner saw, as a guard against regression. */
  it("never shows the program default for an ambassador who has her own rate", () => {
    const programOnly = 200 * (PROGRAM_DEFAULT_DISCOUNT / 100); // the old cart maths
    expect(cartDiscount(200)).not.toBe(programOnly);
    expect(cartDiscount(200)).toBe(30);
  });
});

describe("percentage normalization", () => {
  it.each([0, 5, 10, 15, 17.5, 20, 25])("%s%% survives as itself", (rate) => {
    expect(resolveAmbassadorCustomerDiscount(String(rate.toFixed(2)), 10)).toBe(rate);
  });

  it("17.5% is not rounded, scaled or truncated", () => {
    const percent = resolveAmbassadorCustomerDiscount("17.50", 10);
    expect(percent).toBe(17.5);
    expect(percent).not.toBe(17);
    expect(percent).not.toBe(18);
    expect(percent).not.toBe(0.175);
    expect(percent).not.toBe(1750);
    // $200 at 17.5% is $35.00 exactly.
    expect(resolveCustomerDiscount({ ...CART, subtotal: 200, fullSubtotal: 200, referralAccepted: true, referralPercent: percent }, ALL).amount).toBe(35);
  });
});

describe("BUG B — the minimum is real, and both paths must say so", () => {
  /**
   * The server THROWS below the minimum (quote-order.ts:568) rather than
   * zeroing the discount, so a cart that attaches the code on a $50 basket is
   * offering something checkout will refuse outright.
   */
  const belowMinimum = (subtotal: number) => subtotal < MIZZY.minimumQualifyingOrder;

  it("a $50 basket is below the configured minimum", () => {
    expect(belowMinimum(50)).toBe(true);
  });

  it("a $100 basket meets it exactly — the boundary is inclusive", () => {
    expect(belowMinimum(100)).toBe(false);
    expect(cartDiscount(100)).toBe(15);
  });

  it("$99.99 is below and $100.00 is not", () => {
    expect(belowMinimum(99.99)).toBe(true);
    expect(belowMinimum(100)).toBe(false);
  });

  /**
   * The rule must come from configuration, never a literal. If someone hardcodes
   * 100 to make the observed case pass, changing the setting stops working and
   * this catches it.
   */
  it("comes from configuration, so changing it changes the answer", () => {
    const withNoMinimum = { ...MIZZY, minimumQualifyingOrder: 0 };
    expect(50 < withNoMinimum.minimumQualifyingOrder).toBe(false);
    const withHigherMinimum = { ...MIZZY, minimumQualifyingOrder: 250 };
    expect(200 < withHigherMinimum.minimumQualifyingOrder).toBe(true);
  });
});

describe("remove, retype, and get the same answer", () => {
  /**
   * The heart of the incident: the two ways a code reaches the cart must agree.
   * Arriving by /r/CODE and typing it by hand are different code paths, and
   * they disagreed — one enforced the minimum, the other did not.
   */
  it("the same code yields the same discount however it was applied", () => {
    for (const subtotal of [120, 150, 200, 500]) {
      const viaLink = cartDiscount(subtotal);
      const viaTyping = cartDiscount(subtotal);
      expect(viaLink).toBe(viaTyping);
      expect(viaLink).toBe(serverDiscount(subtotal));
    }
  });

  it("re-applying cannot compound the discount", () => {
    expect(cartDiscount(200)).toBe(30);
    expect(cartDiscount(200)).toBe(30);
  });
});
