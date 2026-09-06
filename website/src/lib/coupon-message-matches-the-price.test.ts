import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeCouponOutcome, resolveCartDiscount } from "@/lib/discount-resolution";

// ---------------------------------------------------------------------------
// "COUPON APPLIED" OVER A TOTAL THE COUPON DID NOT MOVE.
//
// The success line under the code box used to be a constant, and was rewritten
// to derive from the same winner the price derives from so the copy could not
// disagree with the maths. The condition it derives through did not follow PR
// #153, which SPLIT the two stacking licences everywhere the price is decided:
//
//   store-wide stacking   the coupon is added on top of whatever else applies
//   promotion.stackWithCoupon  the coupon is folded into the PROMOTION, and
//                              only counts if that PACKAGE then wins the contest
//
// The cart kept asking the OR of the two — "is a coupon permitted here?" —
// where the price asks "is the coupon actually in this total?". So with
// store-wide stacking off, a promotion carrying stackWithCoupon, and any other
// discount beating the package, the shopper read "Coupon applied — CODE · 20%
// off" beside a total that was a cent for cent the same without it.
//
// The two assertions below are the two halves: the pricing rule, run for real,
// and the condition the cart asks.
// ---------------------------------------------------------------------------

const CART = readFileSync(join(process.cwd(), "src/components/cart-context.tsx"), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\/\/.*$/gm, " ");

/** A basket where a referral beats a coupon-carrying promotion. */
function priced(opts: { allowCouponStacking: boolean; promotionStacksCoupon: boolean }) {
  return resolveCartDiscount({
    subtotal: 400,
    couponDiscountAmount: 40,
    promos: [{ type: "buy3get1", amount: 30 }],
    memberPricingAmount: 0,
    bulkSavingsAmount: 0,
    ambassadorPersonalAmount: 90,
    quantityBundleSavings: 0,
    allowCouponStacking: opts.allowCouponStacking,
    promotionStacksCoupon: opts.promotionStacksCoupon,
  } as never);
}

describe("the price, run for real", () => {
  it("does NOT include a coupon when the promotion that permitted it loses", () => {
    const withCoupon = priced({ allowCouponStacking: false, promotionStacksCoupon: true });
    const withoutCoupon = resolveCartDiscount({
      subtotal: 400,
      couponDiscountAmount: 0,
      promos: [{ type: "buy3get1", amount: 30 }],
      memberPricingAmount: 0,
      bulkSavingsAmount: 0,
      ambassadorPersonalAmount: 90,
      quantityBundleSavings: 0,
      allowCouponStacking: false,
      promotionStacksCoupon: true,
    } as never);

    expect(withCoupon.amount, "the ambassador's 90 wins either way").toBe(withoutCoupon.amount);
    expect(withCoupon.best?.type).toBe("ambassador_personal");
  });

  it("DOES include it when the package wins", () => {
    const packageWins = resolveCartDiscount({
      subtotal: 400,
      couponDiscountAmount: 40,
      promos: [{ type: "buy3get1", amount: 80 }],
      memberPricingAmount: 0,
      bulkSavingsAmount: 0,
      ambassadorPersonalAmount: 90,
      quantityBundleSavings: 0,
      allowCouponStacking: false,
      promotionStacksCoupon: true,
    } as never);
    expect(packageWins.amount, "80 + 40 beats the 90").toBe(120);
  });

  it("DOES include it under store-wide stacking, whoever wins", () => {
    const stacked = priced({ allowCouponStacking: true, promotionStacksCoupon: false });
    expect(stacked.amount).toBe(130);
  });
});

describe("the sentence the shopper reads", () => {
  it("asks whether the coupon is IN the price, not whether one was permitted", () => {
    expect(
      CART,
      "the OR of the two licences is not the pricing rule — see resolveCartDiscount",
    ).not.toContain("activePromotionAllowsCoupon && couponDiscountAmount > 0");
    expect(CART).toContain("couponStackingEnabled || (promotionStacksCoupon && bestDiscount?.type === \"buy3get1\")");
  });

  it("names the winner as the reason, once the winner is asked for correctly", () => {
    // What the corrected condition feeds describeCouponOutcome in the losing
    // case: the ambassador discount controls the price, so the code is
    // recognised and explained rather than claimed.
    const outcome = describeCouponOutcome({
      code: "SAVE20",
      couponDiscountAmount: 40,
      winnerType: "ambassador_personal",
      winnerLabel: "Ambassador discount",
      waivesShipping: false,
    } as never);

    expect(outcome.controlsPrice).toBe(false);
    expect(outcome.message.toLowerCase()).not.toContain("coupon applied");
  });
});
