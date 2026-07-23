import { describe, expect, it } from "vitest";
import {
  resolveCustomerDiscount,
  protectProfit,
  DEFAULT_PROFIT_SETTINGS,
  type OrderInputs,
} from "@/lib/profit-engine";
import { computeRetainedCommission, getCommissionStateForRefund } from "@/lib/payment-webhook";
import { isValidPayoutMethod } from "@/lib/partner-portal";

// Named, adversarial assertions mapped 1:1 to the pre-launch invariants. These
// deliberately feed hostile inputs to the pure money guards and assert the
// guarantee holds. (Concurrency/duplicate-payout/oversell invariants are proven
// separately by the real-Postgres stress script; discount breadth by the >5,000
// order-math sweep. This file locks the specific guarantees as readable specs.)

const BASE: OrderInputs = {
  subtotal: 100,
  productCost: 25,
  bundleDiscount: 0,
  referralAccepted: false,
  referralPercent: 10,
  bundleReferralPercent: 5,
  isMember: false,
  membershipPercent: 0,
  couponDiscount: 0,
  bulkSavingsAmount: 0,
  personalDiscountAmount: 0,
  allowCouponStacking: false,
  commissionPercent: 15,
  processingFeePercent: 10,
  shippingCollected: 0,
  shippingCost: 0,
  handlingCollected: 0,
  taxPercent: 0,
};

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

describe("INVARIANT 1 — customers never receive more discount than intended", () => {
  it("piling on referral + membership + bulk + personal + coupon still yields only the single best (no stacking by default)", () => {
    const d = resolveCustomerDiscount(
      { ...BASE, referralAccepted: true, referralPercent: 10, isMember: true, membershipPercent: 25, bulkSavingsAmount: 15, personalDiscountAmount: 12, couponDiscount: 40 },
      ALL,
    );
    // Best single candidate here is the $40 coupon; nothing stacks on it.
    expect(d.amount).toBe(40);
    expect(d.components).toEqual(["coupon"]);
  });

  it("a discount can never exceed the subtotal", () => {
    const d = resolveCustomerDiscount({ ...BASE, subtotal: 30, couponDiscount: 999 }, ALL);
    expect(d.amount).toBeLessThanOrEqual(30);
  });

  it("the ONLY intentional stack (bundle + reduced referral %) is bounded and labeled", () => {
    const d = resolveCustomerDiscount({ ...BASE, subtotal: 100, bundleDiscount: 20, referralAccepted: true, bundleReferralPercent: 5 }, ALL);
    expect(d.amount).toBe(25); // $20 bundle + 5% of $100
    expect(d.components.sort()).toEqual(["bundle", "referral"]);
  });
});

describe("INVARIANT 4 — membership discounts don't stack incorrectly", () => {
  it("membership competes as ONE candidate; it never adds on top of a coupon unless stacking is explicitly enabled", () => {
    const noStack = resolveCustomerDiscount({ ...BASE, isMember: true, membershipPercent: 20, couponDiscount: 15 }, ALL);
    expect(noStack.amount).toBe(20); // best of (20% membership = $20) vs ($15 coupon)

    const stack = resolveCustomerDiscount({ ...BASE, isMember: true, membershipPercent: 20, couponDiscount: 15, allowCouponStacking: true }, ALL);
    expect(stack.amount).toBe(35); // only when the admin allows coupon stacking
  });
});

describe("INVARIANT 5 — coupons can't bypass profit protection", () => {
  it("an absurd coupon on a thin-margin order is peeled or the order is blocked — never finalizes below break-even", () => {
    const guarded = protectProfit(
      { ...BASE, subtotal: 100, productCost: 60, couponDiscount: 95, processingFeePercent: 10 },
      DEFAULT_PROFIT_SETTINGS,
    );
    if (guarded.profitable) {
      expect(guarded.grossProfit).toBeGreaterThanOrEqual(DEFAULT_PROFIT_SETTINGS.minProfitDollars - 0.001);
      // If it finalized, the money-losing coupon must have been removed.
      expect(guarded.removed).toContain("coupon");
    } else {
      expect(guarded.blockedReason).toBeTruthy();
    }
  });

  it("an order that loses money even at full price is blocked outright", () => {
    const guarded = protectProfit({ ...BASE, subtotal: 50, productCost: 80 }, DEFAULT_PROFIT_SETTINGS);
    expect(guarded.profitable).toBe(false);
    expect(guarded.blockedReason).toBeTruthy();
  });
});

describe("INVARIANT 3 — refunded/cancelled orders don't keep commission", () => {
  it("a full refund voids the commission entirely", () => {
    expect(computeRetainedCommission({ base: 200, percent: 15, refundedFraction: 1 })).toBe(0);
  });

  it("a pending commission is reversed on refund; an already-paid one goes to manual review (never silently kept)", () => {
    expect(getCommissionStateForRefund("pending").status).toBe("reversed");
    expect(getCommissionStateForRefund("paid").status).toBe("manual_review");
  });

  it("a partial refund only ever REDUCES the commission, never increases it", () => {
    const full = computeRetainedCommission({ base: 200, percent: 15, refundedFraction: 0 });
    const partial = computeRetainedCommission({ base: 200, percent: 15, refundedFraction: 0.4 });
    expect(partial).toBeLessThan(full);
    expect(partial).toBeGreaterThanOrEqual(0);
  });
});

describe("INVARIANT 10 — referral/payout exploits are rejected at the boundary", () => {
  it("only the three supported payout methods are accepted; junk/casing is rejected", () => {
    expect(isValidPayoutMethod("paypal")).toBe(true);
    expect(isValidPayoutMethod("zelle")).toBe(false);
    expect(isValidPayoutMethod("PAYPAL")).toBe(false);
    expect(isValidPayoutMethod("")).toBe(false);
  });
});
