import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFIT_SETTINGS,
  computeProfit,
  protectProfit,
  resolveCustomerDiscount,
  type OrderInputs,
  type ProfitSettings,
} from "./profit-engine";
import { computeRetainedCommission, getCommissionStateForRefund } from "./payment-webhook";

// FINAL RELEASE CHECKLIST — "Profit Protection": verify that NO possible
// checkout combination can create an unprofitable order, across every lever the
// user listed (bundle only, referral only, membership only, coupon only,
// bundle+referral, refunds, cancels, shipping thresholds, processing fees,
// product-cost changes) — and then deliberately try to build a money-losing
// order and confirm the guard blocks it.

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

function order(overrides: Partial<OrderInputs> = {}): OrderInputs {
  return {
    subtotal: 260,
    productCost: 120,
    bundleDiscount: 0,
    referralAccepted: false,
    referralPercent: 10,
    bundleReferralPercent: 5,
    isMember: false,
    membershipPercent: 0,
    couponDiscount: 0,
    allowCouponStacking: false,
    commissionPercent: 10,
    processingFeePercent: 10,
    shippingCollected: 0,
    shippingCost: 0,
    handlingCollected: 0,
    taxPercent: 7,
    ...overrides,
  };
}

describe("each single lever, in isolation, never finalizes below break-even", () => {
  it("bundle only", () => {
    const r = protectProfit(order({ bundleDiscount: 30 }));
    expect(r.profitable).toBe(true);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
    expect(r.discount.components).toEqual(["bundle"]);
  });

  it("referral only", () => {
    const r = protectProfit(order({ referralAccepted: true }));
    expect(r.profitable).toBe(true);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
    expect(r.commission).toBeGreaterThan(0); // ambassador still paid
  });

  it("membership only", () => {
    const r = protectProfit(order({ isMember: true, membershipPercent: 15 }));
    expect(r.profitable).toBe(true);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
    expect(r.discount.components).toEqual(["membership"]);
  });

  it("coupon only", () => {
    const r = protectProfit(order({ couponDiscount: 25 }));
    expect(r.profitable).toBe(true);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
  });

  it("bundle + referral (the one intentional stack)", () => {
    const r = protectProfit(order({ bundleDiscount: 30, referralAccepted: true }));
    expect(r.profitable).toBe(true);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
    // Bundle discount + reduced 5% referral stacked, and commission still paid.
    expect(r.discount.components).toContain("bundle");
    expect(r.commission).toBeGreaterThan(0);
  });
});

describe("shipping threshold and processing fee are absorbed into the floor", () => {
  it("free shipping over the threshold still clears break-even (store eats the shipping cost)", () => {
    // Big order → free shipping to the customer, but the business still pays to
    // ship. The guard must account for that real cost.
    const r = protectProfit(order({ subtotal: 300, productCost: 130, shippingCollected: 0, shippingCost: 12 }));
    expect(r.profitable).toBe(true);
    expect(r.shippingCost).toBe(12);
    expect(r.grossProfit).toBeGreaterThanOrEqual(0);
  });

  it("a higher processing fee lowers profit but the floor still holds", () => {
    const low = protectProfit(order({ processingFeePercent: 3 }));
    const high = protectProfit(order({ processingFeePercent: 15 }));
    expect(high.processingFee).toBeGreaterThan(low.processingFee);
    expect(high.grossProfit).toBeGreaterThanOrEqual(0);
  });
});

describe("product cost changes flip the guard from allow to block", () => {
  it("as unit cost rises past the price, an order that was profitable gets blocked", () => {
    const cheap = protectProfit(order({ subtotal: 260, productCost: 100 }));
    const breakevenish = protectProfit(order({ subtotal: 260, productCost: 230 }));
    const underwater = protectProfit(order({ subtotal: 260, productCost: 400 }));
    expect(cheap.profitable).toBe(true);
    expect(underwater.profitable).toBe(false); // cost alone exceeds revenue
    // The transition is monotonic: profit only ever falls as cost rises.
    expect(cheap.grossProfit).toBeGreaterThan(breakevenish.grossProfit);
    expect(breakevenish.grossProfit).toBeGreaterThan(underwater.grossProfit);
  });

  it("blocks rather than stripping a paid membership discount to survive", () => {
    const r = protectProfit(order({ isMember: true, membershipPercent: 15, productCost: 300 }));
    expect(r.removed).not.toContain("membership");
    expect(r.profitable).toBe(false);
  });
});

describe("deliberately trying to lose money — the guard must refuse", () => {
  it("a below-cost coupon order is peeled or blocked, never finalized in the red", () => {
    // $260 of goods that cost $250, with a $100 stacked coupon → deeply negative.
    const r = protectProfit(order({ subtotal: 260, productCost: 250, couponDiscount: 100, allowCouponStacking: true }));
    if (r.profitable) {
      expect(r.grossProfit).toBeGreaterThanOrEqual(0);
      expect(r.removed).toContain("coupon"); // it had to strip the coupon to survive
    } else {
      expect(r.blockedReason).toContain("Promotion unavailable");
    }
  });

  it("an order underwater on cost + commission alone is blocked (commission is never stripped)", () => {
    // Selling below cost with a valid code: nothing removable can save it and
    // the ambassador must still be paid, so the only safe outcome is to block.
    const r = protectProfit(order({ subtotal: 100, productCost: 120, referralAccepted: true, commissionPercent: 20 }));
    expect(r.profitable).toBe(false);
    expect(r.blockedReason).toBeTruthy();
  });
});

// ─── EXHAUSTIVE: no combination of every lever ever finalizes in the red ─────
describe("exhaustive combination sweep: a finalized order is NEVER below break-even", () => {
  const settings: ProfitSettings = DEFAULT_PROFIT_SETTINGS;
  const unitCosts = [22, 28, 33, 40];
  const retails = [45, 65, 89];
  const quantities = [1, 2, 3, 4, 6];
  const bundleDiscounts = [0, 12, 30];
  const memberPercents = [0, 10, 20];
  const couponDiscounts = [0, 15, 40];
  const commissionPercents = [10, 15, 25];
  const shippingPairs = [
    { collected: 15, cost: 8 },   // small order pays shipping
    { collected: 0, cost: 12 },   // free-ship order, store eats cost
  ];
  const bools = [false, true];

  it("holds break-even across the whole matrix and blocks everything it can't save", () => {
    let scenarios = 0;
    let finalized = 0;
    let blocked = 0;

    for (const unitCost of unitCosts) {
      for (const retail of retails) {
        for (const qty of quantities) {
          const subtotal = retail * qty;
          for (const bundleDiscount of bundleDiscounts) {
            for (const membershipPercent of memberPercents) {
              for (const couponDiscount of couponDiscounts) {
                for (const commissionPercent of commissionPercents) {
                  for (const ship of shippingPairs) {
                    for (const referralAccepted of bools) {
                      for (const allowCouponStacking of bools) {
                        scenarios += 1;
                        const inputs: OrderInputs = {
                          subtotal,
                          productCost: unitCost * qty,
                          bundleDiscount: Math.min(bundleDiscount, subtotal),
                          referralAccepted,
                          referralPercent: 10,
                          bundleReferralPercent: 5,
                          isMember: membershipPercent > 0,
                          membershipPercent,
                          couponDiscount: Math.min(couponDiscount, subtotal),
                          allowCouponStacking,
                          commissionPercent,
                          processingFeePercent: settings.processingFeePercent,
                          shippingCollected: ship.collected,
                          shippingCost: ship.cost,
                          handlingCollected: 0,
                          taxPercent: 7,
                        };

                        const r = protectProfit(inputs, settings);

                        if (r.profitable) {
                          finalized += 1;
                          // THE INVARIANT: nothing finalizable is ever in the red.
                          expect(
                            r.grossProfit,
                            `RED ORDER FINALIZED: ${JSON.stringify(inputs)}`,
                          ).toBeGreaterThanOrEqual(settings.minProfitDollars - 0.001);
                          // A valid code always earns the ambassador something on
                          // a profitable, non-zero order.
                          if (referralAccepted && r.discountedSubtotal > 0) {
                            expect(r.commission).toBeGreaterThan(0);
                          }
                          // Never charge a negative amount; discount never exceeds subtotal.
                          expect(r.amountCharged).toBeGreaterThan(0);
                          expect(r.discount.amount).toBeLessThanOrEqual(subtotal + 0.001);
                        } else {
                          blocked += 1;
                          expect(r.blockedReason).toBeTruthy();
                        }
                      }
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
    expect(finalized).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
  });
});

// ─── Refunds & cancels reverse the ambassador commission correctly ──────────
describe("refunds and cancellations reverse commission (money integrity)", () => {
  it("a full refund retains $0 commission", () => {
    const retained = computeRetainedCommission({ base: 234, percent: 10, refundedFraction: 1 });
    expect(retained).toBe(0);
  });

  it("a half refund retains half the commission (on the kept merchandise)", () => {
    const retained = computeRetainedCommission({ base: 234, percent: 10, refundedFraction: 0.5 });
    expect(retained).toBe(11.7); // half of $23.40
  });

  it("no refund retains the full commission", () => {
    const retained = computeRetainedCommission({ base: 234, percent: 10, refundedFraction: 0 });
    expect(retained).toBe(23.4);
  });

  it("a refund on an unpaid commission reverses it outright", () => {
    expect(getCommissionStateForRefund("pending").status).toBe("reversed");
    expect(getCommissionStateForRefund("approved_for_payout").status).toBe("reversed");
  });

  it("a refund AFTER the commission was already paid flags for manual review, never silently claws back", () => {
    const state = getCommissionStateForRefund("paid");
    expect(state.status).toBe("manual_review");
    expect(state.reviewRequired).toBe(true);
  });

  it("commission earned equals commission reversed on a full refund (nets to zero)", () => {
    const o = order({ referralAccepted: true });
    const earned = computeProfit(o, resolveCustomerDiscount(o, ALL)).commission;
    const retained = computeRetainedCommission({ base: o.subtotal - resolveCustomerDiscount(o, ALL).amount, percent: o.commissionPercent, refundedFraction: 1 });
    expect(earned).toBeGreaterThan(0);
    expect(retained).toBe(0);
    expect(earned - retained).toBe(earned); // fully reversed
  });
});
