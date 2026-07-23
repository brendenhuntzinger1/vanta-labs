import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFIT_SETTINGS,
  computeProfit,
  protectProfit,
  resolveCustomerDiscount,
  type OrderInputs,
} from "./profit-engine";

// Base order: 4 vials @ $65 retail, $30 cost each, no promos. Callers override.
function makeOrder(overrides: Partial<OrderInputs> = {}): OrderInputs {
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

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

describe("discount composition rules", () => {
  it("normal order + code → 10% referral to the customer", () => {
    const d = resolveCustomerDiscount(makeOrder({ referralAccepted: true }), ALL);
    expect(d.amount).toBe(26); // 10% of 260
    expect(d.components).toEqual(["referral"]);
  });

  it("bundle order + code → bundle discount PLUS an extra 5% referral (stacked)", () => {
    const d = resolveCustomerDiscount(makeOrder({ bundleDiscount: 20, referralAccepted: true }), ALL);
    expect(d.amount).toBe(33); // 20 bundle + 5% of 260 (13)
    expect(d.components).toEqual(["bundle", "referral"]);
  });

  it("bundle order, no code → bundle discount only", () => {
    const d = resolveCustomerDiscount(makeOrder({ bundleDiscount: 20 }), ALL);
    expect(d.amount).toBe(20);
    expect(d.components).toEqual(["bundle"]);
  });

  it("member → membership pricing only, no referral customer discount even with a code", () => {
    const d = resolveCustomerDiscount(
      makeOrder({ isMember: true, membershipPercent: 15, referralAccepted: true, bundleDiscount: 20 }),
      ALL,
    );
    expect(d.amount).toBe(39); // 15% of 260, membership exclusive
    expect(d.components).toEqual(["membership"]);
  });

  it("coupon does NOT stack with a referral by default (best single wins)", () => {
    const d = resolveCustomerDiscount(makeOrder({ referralAccepted: true, couponDiscount: 5 }), ALL);
    expect(d.components).toEqual(["referral"]); // 26 referral beats 5 coupon
    expect(d.amount).toBe(26);
  });

  it("coupon stacks with a referral only when the admin enables it", () => {
    const d = resolveCustomerDiscount(makeOrder({ referralAccepted: true, couponDiscount: 5, allowCouponStacking: true }), ALL);
    expect(d.components).toEqual(["referral", "coupon"]);
    expect(d.amount).toBe(31); // 26 + 5
  });
});

describe("ambassador commission", () => {
  it("is paid on the discounted subtotal whenever a code is accepted", () => {
    const order = makeOrder({ referralAccepted: true }); // 10% off → 234 discounted
    const p = computeProfit(order, resolveCustomerDiscount(order, ALL));
    expect(p.discountedSubtotal).toBe(234);
    expect(p.commission).toBe(23.4); // 10% of 234
  });

  it("is paid even when membership pricing (not the referral) applied", () => {
    const order = makeOrder({ isMember: true, membershipPercent: 15, referralAccepted: true });
    const p = computeProfit(order, resolveCustomerDiscount(order, ALL));
    // Customer got membership pricing; ambassador still earns on the discounted subtotal.
    expect(p.commission).toBeGreaterThan(0);
  });

  it("is zero when no code is on the order", () => {
    const order = makeOrder();
    const p = computeProfit(order, resolveCustomerDiscount(order, ALL));
    expect(p.commission).toBe(0);
  });
});

describe("profit protection guardrail", () => {
  it("lets a healthy order through untouched", () => {
    const result = protectProfit(makeOrder({ referralAccepted: true }));
    expect(result.profitable).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("peels off discounts to restore margin on a thin order", () => {
    // High cost + big coupon would sink the order; the guard removes the coupon.
    const result = protectProfit(
      makeOrder({ productCost: 132, couponDiscount: 60, allowCouponStacking: true, referralAccepted: true }),
    );
    if (result.profitable) {
      expect(result.grossProfit).toBeGreaterThanOrEqual(DEFAULT_PROFIT_SETTINGS.minProfitDollars);
      expect(result.removed).toContain("coupon");
    }
  });

  it("blocks an order that loses money even with every promo removed", () => {
    // Selling 4 vials at $26 each ($104) that cost $33 each ($132) can never be
    // profitable — no promo removal can save it, so it must be blocked.
    const result = protectProfit(makeOrder({ subtotal: 104, productCost: 132 }));
    expect(result.profitable).toBe(false);
    expect(result.blockedReason).toContain("Promotion unavailable");
  });

  it("never removes a paid membership discount for margin", () => {
    const result = protectProfit(makeOrder({ isMember: true, membershipPercent: 15, productCost: 130 }));
    expect(result.removed).not.toContain("membership");
  });
});

// ─── EXHAUSTIVE SIMULATION ────────────────────────────────────────────────
// Every combination of worst-case-ish costs, order sizes, and promos. The core
// invariant: an order the engine marks `profitable` ALWAYS meets the floor, and
// the engine never silently lets a losing order finalize.
describe("simulation: no finalized order ever falls below the profit floor", () => {
  const settings = DEFAULT_PROFIT_SETTINGS; // 25% / $10, worst-case $33, 10% fee
  const unitCosts = [25, 27, 29, 31, 33]; // wholesale+fulfillment range
  const retails = [55, 65, 79];
  const quantities = [1, 2, 3, 4, 6, 8];
  const bools = [false, true];
  const commissionPercents = [10, 12, 15, 20];
  const bundleDiscounts = [0, 15, 30];
  const memberPercents = [0, 10, 15];
  const couponDiscounts = [0, 10, 25];

  let scenarios = 0;
  let profitable = 0;
  let blocked = 0;

  it("holds the invariant across the full matrix", () => {
    for (const unitCost of unitCosts) {
      for (const retail of retails) {
        for (const qty of quantities) {
          const subtotal = retail * qty;
          for (const bundleDiscount of bundleDiscounts) {
            for (const referralAccepted of bools) {
              for (const commissionPercent of commissionPercents) {
                for (const membershipPercent of memberPercents) {
                  for (const couponDiscount of couponDiscounts) {
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
                        shippingCollected: subtotal >= 250 ? 0 : 15,
                        shippingCost: 8,
                        handlingCollected: 0,
                        taxPercent: 7,
                      };

                      const result = protectProfit(inputs, settings);

                      // THE INVARIANT: anything the engine says is finalizable
                      // must clear both floors.
                      if (result.profitable) {
                        profitable += 1;
                        expect(
                          result.grossProfit,
                          `profit ${result.grossProfit} < $${settings.minProfitDollars} for ${JSON.stringify(inputs)}`,
                        ).toBeGreaterThanOrEqual(settings.minProfitDollars - 0.001);
                        if (result.discountedSubtotal > 0) {
                          expect(
                            result.grossMarginPercent,
                            `margin ${result.grossMarginPercent}% < ${settings.minProfitPercent}% for ${JSON.stringify(inputs)}`,
                          ).toBeGreaterThanOrEqual(settings.minProfitPercent - 0.001);
                        }
                        // A profitable order never charges a negative amount.
                        expect(result.amountCharged).toBeGreaterThan(0);
                        // Discount never exceeds the subtotal.
                        expect(result.discount.amount).toBeLessThanOrEqual(subtotal + 0.001);
                      } else {
                        blocked += 1;
                        expect(result.blockedReason).toBeTruthy();
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

    // Sanity: the matrix actually ran at scale and exercised both outcomes.
    expect(scenarios).toBeGreaterThan(5000);
    expect(profitable).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
  });
});
