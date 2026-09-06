import { describe, expect, it } from "vitest";
import {
  computeProfit,
  resolveCustomerDiscount,
  type OrderInputs,
} from "./profit-engine";
import { buildProfitFloorSnapshot } from "./profit-floor-alert";
import { computeRetainedCommission, getCommissionStateForRefund } from "./payment-webhook";

// FINAL RELEASE CHECKLIST — "Profit Protection", REWRITTEN FOR THE POLICY THAT
// REPLACED IT.
//
// This file used to verify that no checkout combination could create an
// unprofitable order, and that the guard BLOCKED anything it could not save.
// The store no longer works that way, for a reason that showed up in its own
// numbers: on the real catalogue and the real ambassador rates, the block
// refused 8 of 24 ordinary baskets — including a single $39.99 vial — and it
// refused them silently. A $79.98 sale was turned away to protect $1.32.
//
// The rule now: an otherwise valid order is NEVER refused for margin. It
// completes, and the owner is told. `protectProfit`, which did the peeling and
// the blocking, had no production caller and is gone.
//
// So every lever below is still exercised — bundle, referral, membership,
// coupon, bundle+referral, shipping thresholds, processing fees, product-cost
// changes, and a deliberate attempt to lose money — and what is asserted is
// that each one PRICES, and that the below-floor flag tells the truth about it.

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);
const FLOOR = { minProfitDollars: 0, minProfitPercent: 0 };

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

/** Price an order the way checkout does, and report it the way the owner sees. */
function priced(inputs: OrderInputs, settings: { minProfitDollars: number; minProfitPercent: number } = FLOOR) {
  const discount = resolveCustomerDiscount(inputs, ALL);
  const profit = computeProfit(inputs, discount);
  return {
    discount,
    profit,
    snapshot: buildProfitFloorSnapshot(profit, settings, discount.label, inputs.shippingCollected),
  };
}

describe("each single lever prices, and is reported honestly", () => {
  it("bundle only", () => {
    const r = priced(order({ bundleDiscount: 30 }));
    expect(r.discount.amount).toBe(30);
    expect(r.snapshot.belowFloor).toBe(false);
  });

  it("referral only", () => {
    const r = priced(order({ referralAccepted: true }));
    expect(r.snapshot.belowFloor).toBe(false);
    // Commission is a real cost and is reported as its own line.
    expect(r.snapshot.commission).toBeGreaterThan(0);
  });

  it("membership only", () => {
    const r = priced(order({ isMember: true, membershipPercent: 15 }));
    expect(r.snapshot.belowFloor).toBe(false);
  });

  it("coupon only", () => {
    const r = priced(order({ couponDiscount: 25 }));
    expect(r.discount.amount).toBe(25);
    expect(r.snapshot.belowFloor).toBe(false);
  });

  it("bundle + referral: free item only (no stack), commission still paid", () => {
    const r = priced(order({ bundleDiscount: 30, referralAccepted: true }));
    // The two compete; only one applies. The ambassador is paid either way.
    expect(r.discount.amount).toBe(30);
    expect(r.snapshot.commission).toBeGreaterThan(0);
    expect(r.snapshot.belowFloor).toBe(false);
  });
});

describe("shipping and processing fees are reflected in the report", () => {
  it("free shipping over the threshold shows the store's shipping cost", () => {
    const r = priced(order({ subtotal: 300, productCost: 130, shippingCollected: 0, shippingCost: 12 }));
    expect(r.snapshot.shippingCollected).toBe(0);
    expect(r.snapshot.shippingCost).toBe(12);
    expect(r.snapshot.belowFloor).toBe(false);
  });

  it("a higher processing fee lowers the reported profit", () => {
    const cheap = priced(order({ processingFeePercent: 3 }));
    const dear = priced(order({ processingFeePercent: 15 }));
    expect(dear.snapshot.processingFee).toBeGreaterThan(cheap.snapshot.processingFee);
    expect(dear.snapshot.estimatedProfit).toBeLessThan(cheap.snapshot.estimatedProfit);
  });
});

describe("product cost flips the REPORT, never the outcome", () => {
  it("as unit cost rises past the price the order still prices — and is flagged", () => {
    const healthy = priced(order({ subtotal: 260, productCost: 100 }));
    expect(healthy.snapshot.belowFloor).toBe(false);

    const thin = priced(order({ subtotal: 260, productCost: 230 }));
    const underwater = priced(order({ subtotal: 260, productCost: 400 }));
    expect(underwater.snapshot.belowFloor).toBe(true);
    expect(underwater.snapshot.estimatedProfit).toBeLessThan(thin.snapshot.estimatedProfit);
    // Both still produced a price. Nothing refused anything.
    expect(underwater.profit.amountCharged).toBeGreaterThan(0);
  });

  it("never strips a paid membership discount to improve the report", () => {
    const r = priced(order({ isMember: true, membershipPercent: 15, productCost: 300 }));
    expect(r.discount.components).toContain("membership");
    expect(r.snapshot.belowFloor).toBe(true);
  });
});

describe("deliberately trying to lose money — the sale still goes through", () => {
  it("a below-cost coupon order finalizes in the red, and says so", () => {
    const r = priced(order({ subtotal: 260, productCost: 250, couponDiscount: 100, allowCouponStacking: true }));
    expect(r.discount.amount).toBe(100);
    expect(r.snapshot.belowFloor).toBe(true);
    expect(r.snapshot.estimatedProfit).toBeLessThan(0);
  });

  it("an order underwater on cost + commission alone finalizes, and says so", () => {
    const r = priced(order({ subtotal: 100, productCost: 120, referralAccepted: true, commissionPercent: 20 }));
    expect(r.snapshot.belowFloor).toBe(true);
    expect(r.snapshot.commission).toBeGreaterThan(0);
    expect(r.snapshot.productCost).toBe(120);
  });
});

describe("exhaustive combination sweep: every combination prices, and reports truthfully", () => {
  it("holds across the whole matrix", () => {
    let scenarios = 0, flagged = 0, clean = 0;
    for (const productCost of [80, 120, 200, 300]) {
      for (const bundleDiscount of [0, 30]) {
        for (const referralAccepted of [false, true]) {
          for (const membershipPercent of [0, 15]) {
            for (const couponDiscount of [0, 25, 100]) {
              for (const allowCouponStacking of [false, true]) {
                for (const processingFeePercent of [3, 10]) {
                  scenarios += 1;
                  const inputs = order({
                    productCost, bundleDiscount, referralAccepted,
                    isMember: membershipPercent > 0, membershipPercent,
                    couponDiscount, allowCouponStacking, processingFeePercent,
                  });
                  const r = priced(inputs);

                  // The flag says exactly what the thresholds say.
                  const expectedBelow = r.profit.grossProfit < FLOOR.minProfitDollars
                    || (r.profit.discountedSubtotal > 0 && r.profit.grossMarginPercent < FLOOR.minProfitPercent);
                  expect(r.snapshot.belowFloor, JSON.stringify(inputs)).toBe(expectedBelow);
                  if (expectedBelow) flagged += 1; else clean += 1;

                  // Whatever the margin, the order is priceable and sane.
                  expect(r.discount.amount).toBeLessThanOrEqual(inputs.subtotal + 0.001);
                  expect(r.profit.amountCharged).toBeGreaterThanOrEqual(0);
                  expect(r.snapshot.estimatedProfit).toBeCloseTo(r.profit.grossProfit, 2);
                }
              }
            }
          }
        }
      }
    }
    // The sweep exercised both outcomes; both COMPLETE.
    expect(scenarios).toBeGreaterThan(100);
    expect(flagged).toBeGreaterThan(0);
    expect(clean).toBeGreaterThan(0);
  });
});

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
