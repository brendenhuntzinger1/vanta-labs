import { describe, expect, it } from "vitest";

import { resolveBestDiscount, type DiscountType } from "@/lib/discount-resolution";
import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";

// ---------------------------------------------------------------------------
// THE PRICE IN THE CART HAS TO BE THE PRICE ON THE CARD.
//
// Two different functions decide which single discount wins:
//
//   cart-context.tsx  -> resolveBestDiscount   (what the shopper is shown)
//   quote-order.ts    -> resolveCustomerDiscount (what the card is charged)
//
// discount-resolution.ts opens with "shared by the client cart preview and the
// server checkout total so both always agree on which single discount is
// actually applied". The server does not call it. Nothing tested that claim,
// and the two are assembled differently:
//
//   THE CART builds a PRIORITY CHAIN. buy3get1 wins outright; failing that a
//   valid referral; failing that the coupon. Exactly one of those three ever
//   becomes a candidate, alongside bulk / member / ambassador-personal.
//
//   THE SERVER lets them COMPETE. bundleDiscount and couponDiscount are passed
//   in together and both enter the candidate list (referral is suppressed when
//   a bundle is present, matching the cart).
//
// Same inputs, two shapes. This file feeds both the same scenarios and checks
// they land on the same number.
//
// WHAT IT FOUND, AND WHY NOTHING WAS CHANGED. They diverge on exactly one
// combination: a Buy-3-Get-1 bundle AND a coupon worth more than the free item.
// The cart's chain stops at buy3get1 so the coupon never competes; the server
// picks the larger. On a $300 cart with a $20 free item and a $50 coupon the
// cart shows $20 off and the card is charged $50 off — the shopper is charged
// LESS than displayed, never more, so no one is overcharged.
//
// Both preconditions are currently OFF in production, independently:
//   promotions.buy_3_get_1_enabled = false   (set by the owner 2026-08-23)
//   all 335 active coupons expired on or before 2026-08-06; none is live
// and no order in the store's history has ever carried a coupon code.
//
// So it is unreachable today, and the fix would mean changing how the live
// checkout assembles and LABELS discounts (preBulkDiscount also feeds
// appliedDiscountLabel and autoBestDiscountApplied) for every shopper, to
// correct a display that currently cannot happen and errs in the customer's
// favour. That is more risk than the defect carries. It is left alone,
// deliberately, and pinned here instead: the moment someone enables
// Buy-3-Get-1 and issues a live coupon, this file says so out loud.
//
// The cart's candidate ASSEMBLY is inline in a React component and cannot be
// imported, so buildCartCandidates below restates that chain. It is the one
// mirrored thing in this file and it is marked as such — every discount AMOUNT
// on both sides comes from the real functions.
// ---------------------------------------------------------------------------

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);
const round = (v: number) => Math.round(v * 100) / 100;

interface Scenario {
  name: string;
  subtotal: number;
  /** Quantity-bundle pricing already baked into subtotal. */
  quantityBundleSavings?: number;
  buy3Get1?: number;
  referralPercent?: number;
  memberPercent?: number;
  couponDiscount?: number;
  bulkSavings?: number;
  personalDiscount?: number;
  allowCouponStacking?: boolean;
}

function serverAmount(s: Scenario): number {
  const fullSubtotal = s.subtotal + (s.quantityBundleSavings ?? 0);
  const inputs: OrderInputs = {
    subtotal: s.subtotal,
    fullSubtotal,
    quantityBundleSavings: s.quantityBundleSavings ?? 0,
    productCost: 0,
    bundleDiscount: s.buy3Get1 ?? 0,
    referralAccepted: Boolean(s.referralPercent),
    referralPercent: s.referralPercent ?? 0,
    isMember: Boolean(s.memberPercent),
    membershipPercent: s.memberPercent ?? 0,
    couponDiscount: s.couponDiscount ?? 0,
    bulkSavingsAmount: s.bulkSavings ?? 0,
    personalDiscountAmount: s.personalDiscount ?? 0,
    allowCouponStacking: s.allowCouponStacking ?? false,
    commissionPercent: 0,
    processingFeePercent: 0,
    shippingCollected: 0,
    shippingCost: 0,
    handlingCollected: 0,
    taxPercent: 0,
  };
  return resolveCustomerDiscount(inputs, ALL).amount;
}

/**
 * MIRRORED, deliberately: cart-context.tsx assembles these inline inside a
 * component. The chain, competeWithBundle and the subtotal cap are copied from
 * lines 684-732 of that file. resolveBestDiscount itself is the real one.
 */
function cartAmount(s: Scenario): number {
  const alreadyGranted = s.quantityBundleSavings ?? 0;
  const base = s.subtotal + alreadyGranted;
  const compete = (raw: number) => Math.max(0, round(raw - alreadyGranted));

  const preBulk: { type: DiscountType; amount: number } =
    (s.buy3Get1 ?? 0) > 0
      ? { type: "buy3get1", amount: s.buy3Get1 ?? 0 }
      : s.referralPercent
        ? { type: "referral", amount: base * (s.referralPercent / 100) }
        : { type: "coupon", amount: s.couponDiscount ?? 0 };

  const best = resolveBestDiscount([
    { type: "bulk_savings", amount: compete(s.bulkSavings ?? 0) },
    { type: "member_pricing", amount: compete(s.memberPercent ? base * (s.memberPercent / 100) : 0) },
    { type: "ambassador_personal", amount: compete(s.personalDiscount ?? 0) },
    { type: preBulk.type, amount: compete(preBulk.amount) },
  ]);
  return round(Math.min(s.subtotal, best?.amount ?? 0));
}

// Referral and coupon are mutually exclusive in cart state — applying either
// clears the other (cart-context.tsx:1059 and :1144) — so no scenario here
// carries both. A combination the UI cannot produce proves nothing.
const REACHABLE: Scenario[] = [
  { name: "nothing applied", subtotal: 120 },
  { name: "coupon alone", subtotal: 120, couponDiscount: 15 },
  { name: "referral alone", subtotal: 200, referralPercent: 20 },
  { name: "member alone", subtotal: 200, memberPercent: 10 },
  { name: "bulk alone", subtotal: 400, bulkSavings: 32 },
  { name: "ambassador personal alone", subtotal: 200, personalDiscount: 25 },
  { name: "member vs a bigger coupon", subtotal: 200, memberPercent: 10, couponDiscount: 45 },
  { name: "member vs a smaller coupon", subtotal: 200, memberPercent: 15, couponDiscount: 10 },
  { name: "member vs a bigger referral", subtotal: 200, memberPercent: 5, referralPercent: 20 },
  { name: "member vs a smaller referral", subtotal: 200, memberPercent: 20, referralPercent: 5 },
  { name: "bulk vs coupon, bulk wins", subtotal: 500, bulkSavings: 60, couponDiscount: 25 },
  { name: "bulk vs coupon, coupon wins", subtotal: 500, bulkSavings: 20, couponDiscount: 75 },
  { name: "personal vs member", subtotal: 300, personalDiscount: 40, memberPercent: 10 },
  { name: "bundle alone", subtotal: 300, buy3Get1: 25 },
  { name: "bundle vs a bigger member discount", subtotal: 300, buy3Get1: 20, memberPercent: 15 },
  { name: "bundle vs bulk", subtotal: 600, buy3Get1: 30, bulkSavings: 90 },
  { name: "bundle beats the referral it suppresses", subtotal: 300, buy3Get1: 60, referralPercent: 10 },
  { name: "quantity bundle already in the subtotal", subtotal: 270, quantityBundleSavings: 30, memberPercent: 10 },
  { name: "quantity bundle swallows a small coupon", subtotal: 270, quantityBundleSavings: 30, couponDiscount: 12 },
  { name: "quantity bundle beaten by a large coupon", subtotal: 270, quantityBundleSavings: 30, couponDiscount: 90 },
  { name: "a discount larger than the cart", subtotal: 40, couponDiscount: 500 },
  { name: "an empty cart", subtotal: 0, couponDiscount: 20 },
];

describe("what the shopper is shown is what the card is charged", () => {
  it.each(REACHABLE)("$name", (scenario) => {
    expect(cartAmount(scenario)).toBe(serverAmount(scenario));
  });

  it("no discount ever exceeds the cart, on either side", () => {
    for (const scenario of REACHABLE) {
      expect(serverAmount(scenario)).toBeLessThanOrEqual(scenario.subtotal);
      expect(cartAmount(scenario)).toBeLessThanOrEqual(scenario.subtotal);
      expect(serverAmount(scenario)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the one combination they do NOT agree on", () => {
  /**
   * Kept as an explicit, named exception rather than deleted, so the gap is a
   * fact in the suite instead of a silence. If a change ever makes these agree,
   * this test fails and the exception should be removed — that is the intended
   * direction.
   */
  const BUNDLE_PLUS_BIGGER_COUPON: Scenario = { name: "x", subtotal: 300, buy3Get1: 20, couponDiscount: 50 };

  it("a bundle plus a larger coupon: the card is charged less than the cart shows", () => {
    expect(cartAmount(BUNDLE_PLUS_BIGGER_COUPON)).toBe(20);
    expect(serverAmount(BUNDLE_PLUS_BIGGER_COUPON)).toBe(50);
  });

  it("errs in the customer's favour — never the other way", () => {
    for (const coupon of [1, 19.99, 20, 20.01, 50, 200, 500]) {
      const scenario: Scenario = { name: "x", subtotal: 300, buy3Get1: 20, couponDiscount: coupon };
      expect(serverAmount(scenario)).toBeGreaterThanOrEqual(cartAmount(scenario));
    }
  });

  it("agrees again as soon as the free item is worth more than the coupon", () => {
    const scenario: Scenario = { name: "x", subtotal: 300, buy3Get1: 60, couponDiscount: 25 };
    expect(cartAmount(scenario)).toBe(serverAmount(scenario));
  });
});

describe("the admin stacking switch, which is off in production", () => {
  /**
   * With stacking ON the server deliberately adds the coupon on top of the best
   * promo. The cart has no equivalent branch, so this is a SECOND known
   * divergence — dormant behind the same switch (coupons.allow_stacking =
   * false, set by the owner 2026-08-23). Recorded, not fixed, for the same
   * reason as the first.
   */
  it("the server stacks a coupon on the best promo when told to", () => {
    const stacked = serverAmount({ name: "x", subtotal: 300, memberPercent: 10, couponDiscount: 40, allowCouponStacking: true });
    expect(stacked).toBe(70); // $30 membership + $40 coupon
  });

  it("and does not when told not to", () => {
    const unstacked = serverAmount({ name: "x", subtotal: 300, memberPercent: 10, couponDiscount: 40 });
    expect(unstacked).toBe(40); // the larger of the two, alone
  });

  it("still never exceeds the cart when stacking", () => {
    const huge = serverAmount({ name: "x", subtotal: 50, memberPercent: 50, couponDiscount: 400, allowCouponStacking: true });
    expect(huge).toBe(50);
  });
});
