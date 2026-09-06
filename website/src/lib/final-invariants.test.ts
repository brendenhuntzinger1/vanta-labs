import { describe, expect, it } from "vitest";
import {
  computeProfit,
  resolveCustomerDiscount,
  type OrderInputs,
} from "@/lib/profit-engine";
import { buildProfitFloorSnapshot } from "@/lib/profit-floor-alert";
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

  it("discounts never stack: a bundle order with a referral code gets the free item only", () => {
    const d = resolveCustomerDiscount({ ...BASE, subtotal: 100, bundleDiscount: 20, referralAccepted: true, bundleReferralPercent: 5 }, ALL);
    expect(d.amount).toBe(20); // $20 bundle only; the referral % does not stack on a bundle
    expect(d.components).toEqual(["bundle"]);
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

// INVARIANT 5 CHANGED SIDES, DELIBERATELY.
//
// It read "coupons can't bypass profit protection" and asserted that an absurd
// coupon on a thin-margin order was peeled or the order blocked. Neither
// happens now: the store's rule is that a valid order is never refused for
// margin, and `protectProfit` (which did the peeling) had no production caller
// and has been removed.
//
// What must still hold is that the store is TOLD. A money-losing combination
// prices, completes, and is flagged — with figures that reconcile.
describe("INVARIANT 5 — a money-losing combination is reported, never refused", () => {
  const SETTINGS = { minProfitDollars: 0, minProfitPercent: 0 };

  it("flags an absurd coupon on a thin-margin order instead of peeling it", () => {
    const inputs = { ...BASE, subtotal: 100, productCost: 60, couponDiscount: 95, processingFeePercent: 10 };
    const discount = resolveCustomerDiscount(inputs, ALL);
    const profit = computeProfit(inputs, discount);
    const snapshot = buildProfitFloorSnapshot(profit, SETTINGS, discount.label, inputs.shippingCollected);

    // The coupon is still in the price — nothing was removed for margin.
    expect(discount.amount).toBe(95);
    expect(snapshot.belowFloor).toBe(true);
    expect(snapshot.estimatedProfit).toBeLessThan(0);
    expect(snapshot.discountAmount).toBe(95);
  });

  it("flags an order that loses money even at full price", () => {
    const inputs = { ...BASE, subtotal: 50, productCost: 80 };
    const discount = resolveCustomerDiscount(inputs, ALL);
    const snapshot = buildProfitFloorSnapshot(
      computeProfit(inputs, discount), SETTINGS, discount.label, inputs.shippingCollected,
    );

    expect(snapshot.belowFloor).toBe(true);
    expect(snapshot.estimatedProfit).toBeLessThan(0);
  });

  it("says nothing about a healthy order", () => {
    const inputs = { ...BASE, subtotal: 300, productCost: 90 };
    const discount = resolveCustomerDiscount(inputs, ALL);
    const snapshot = buildProfitFloorSnapshot(
      computeProfit(inputs, discount), SETTINGS, discount.label, inputs.shippingCollected,
    );

    expect(snapshot.belowFloor).toBe(false);
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
