import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { computeRetainedCommission, getCommissionStateForRefund } from "@/lib/payment-webhook";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";
import { getBundleDiscountedUnitPrice, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";

// ===========================================================================
// AMBASSADOR REGRESSION SUITE — EXACT DOLLARS, NOT "IT RETURNED SOMETHING".
//
// The ambassador work touched three shared files. This suite exists to prove
// two things:
//
//   1. A shopper with NO referral code is charged exactly what they were
//      charged before any of it. That is the regression that would matter and
//      the one nobody would notice, because the store would keep taking money.
//
//   2. Where ambassador logic DOES apply, every figure is the one a human
//      would compute by hand.
//
// Every assertion below is a specific dollar amount. A test that only checks a
// function did not throw would pass just as happily against wrong money.
// ===========================================================================

// The pricing engine's real inputs. Ambassador fields default to "no code".
const CART: OrderInputs = {
  subtotal: 104.97,
  productCost: 0,
  bundleDiscount: 0,
  referralAccepted: false,
  referralPercent: 10,
  isMember: false,
  membershipPercent: 0,
  couponDiscount: 0,
  bulkSavingsAmount: 0,
  personalDiscountAmount: 0,
  allowCouponStacking: false,
  commissionPercent: 15,
  processingFeePercent: 8,
  shippingCollected: 0,
  shippingCost: 0,
  handlingCollected: 0,
  taxPercent: 0,
};

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

const round = (v: number) => Math.round(v * 100) / 100;

/** The commission the webhook computes: rate applied to the DISCOUNTED
 *  merchandise subtotal. Mirrors payment-webhook.ts:652. */
const commissionFor = (subtotal: number, discount: number, percent: number) =>
  round(round(subtotal - discount) * (percent / 100));

/** The $100 gate tests the PRE-discount subtotal (payment-webhook.ts:647). */
const qualifies = (preDiscountSubtotal: number, minimum = DEFAULT_MINIMUM_QUALIFYING_ORDER) =>
  preDiscountSubtotal >= minimum;

// ---------------------------------------------------------------------------
// THE ONE THAT MATTERS MOST.
//
// If ambassador code can move the total of an order that carries no ambassador
// code, every sale in the store is affected. Nothing else in this file is as
// important as this block.
// ---------------------------------------------------------------------------
describe("ordinary checkout, no referral code — totals must be untouched", () => {
  it("charges the plain subtotal when nothing applies", () => {
    const d = resolveCustomerDiscount(CART, ALL);
    expect(d.amount).toBe(0);
    expect(round(CART.subtotal - d.amount)).toBe(104.97);
  });

  it("an ambassador's configured rate cannot reach an order without a code", () => {
    // referralPercent is 10 on the cart, but referralAccepted is false. The
    // percent alone must never produce a discount.
    const noCode = resolveCustomerDiscount({ ...CART, referralPercent: 90 }, ALL);
    expect(noCode.amount).toBe(0);
  });

  it("keeps the coupon path identical", () => {
    const d = resolveCustomerDiscount({ ...CART, couponDiscount: 15 }, ALL);
    expect(d.amount).toBe(15);
    expect(d.components).toEqual(["coupon"]);
  });

  it("keeps membership pricing identical", () => {
    const d = resolveCustomerDiscount({ ...CART, isMember: true, membershipPercent: 20 }, ALL);
    expect(d.amount).toBe(20.99); // 104.97 x 20% = 20.994 -> 20.99
  });

  it("keeps quantity/bundle pricing identical", () => {
    // 2 units = 5% off the unit price, 3+ = 8%. Unchanged by ambassador work.
    expect(getBundleDiscountedUnitPrice(44.99, 1, DEFAULT_BUNDLE_CONFIG)).toBe(44.99);
    expect(getBundleDiscountedUnitPrice(44.99, 2, DEFAULT_BUNDLE_CONFIG)).toBe(42.74);
    expect(getBundleDiscountedUnitPrice(44.99, 3, DEFAULT_BUNDLE_CONFIG)).toBe(41.39);
  });

  it("keeps the Buy-3-Get-1 bundle discount identical", () => {
    const d = resolveCustomerDiscount({ ...CART, bundleDiscount: 44.99 }, ALL);
    expect(d.amount).toBe(44.99);
    expect(d.components).toEqual(["bundle"]);
  });
});

// ---------------------------------------------------------------------------
// THE $100 GATE. Your stated policy, asserted at the boundary.
// ---------------------------------------------------------------------------
describe("the $100 minimum qualifying order", () => {
  it("is $100", () => {
    expect(DEFAULT_MINIMUM_QUALIFYING_ORDER).toBe(100);
  });

  // $99.98 is the real near-miss from this catalogue: BPC-157 5mg + Selank.
  it("a $99.98 referred order earns NO commission", () => {
    expect(qualifies(99.98)).toBe(false);
  });

  it("a $99.99 referred order earns NO commission", () => {
    expect(qualifies(99.99)).toBe(false);
  });

  it("exactly $100.00 qualifies — the test is >=, not >", () => {
    expect(qualifies(100)).toBe(true);
  });

  it("$104.97 qualifies", () => {
    expect(qualifies(104.97)).toBe(true);
  });

  // The subtlety that decides real money: the gate reads the PRE-discount
  // subtotal, so a qualifying cart is never disqualified by its own referral
  // discount. A $104.97 cart nets $94.47 -- under $100 -- and still qualifies.
  it("a qualifying cart is not disqualified by its own discount", () => {
    const discount = round(104.97 * 0.1);
    expect(round(104.97 - discount)).toBe(94.47);
    expect(qualifies(104.97)).toBe(true);
  });

  // ...and a customer discount still applies below the minimum. The shopper
  // saves; the ambassador simply earns nothing.
  it("still discounts the customer below $100, at $0 commission", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal: 99.98, referralAccepted: true, referralPercent: 10 }, ALL);
    expect(d.amount).toBe(10); // 99.98 x 10% = 9.998 -> 10.00
    expect(qualifies(99.98)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WORKED EXAMPLE. The cart chosen for the live test, to the cent.
// ---------------------------------------------------------------------------
describe("order #1 — 10% customer discount, 15% commission", () => {
  const subtotal = 104.97; // BPC-157 5mg + MT-2 10mg + Bac Water 10mL, qty 1 each

  it("discounts the customer $10.50", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal, referralAccepted: true, referralPercent: 10 }, ALL);
    expect(d.amount).toBe(10.5); // 10.497 rounds UP
    expect(d.components).toEqual(["referral"]);
  });

  it("leaves a $94.47 commission base", () => {
    expect(round(subtotal - 10.5)).toBe(94.47);
  });

  it("pays the ambassador $14.17", () => {
    expect(commissionFor(subtotal, 10.5, 15)).toBe(14.17); // 14.1705 -> 14.17
  });
});

describe("order #2 — rates changed to 15% / 20%", () => {
  const subtotal = 104.97;

  it("discounts the customer $15.75", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal, referralAccepted: true, referralPercent: 15 }, ALL);
    expect(d.amount).toBe(15.75); // 15.7455 -> 15.75
  });

  it("pays the ambassador $17.84", () => {
    expect(commissionFor(subtotal, 15.75, 20)).toBe(17.84); // 89.22 x 20% = 17.844
  });

  // The snapshot property stated as arithmetic: the two orders must produce
  // different money from the same cart, and order #1's figures must not move.
  it("produces different money than order #1 from an identical cart", () => {
    expect(commissionFor(subtotal, 10.5, 15)).toBe(14.17);
    expect(commissionFor(subtotal, 15.75, 20)).toBe(17.84);
  });
});

// ---------------------------------------------------------------------------
// THE TWO RATES ARE INDEPENDENT.
// ---------------------------------------------------------------------------
describe("independent rates", () => {
  const PROGRAM_DEFAULT = 10;

  it("uses an ambassador's own discount over the program default", () => {
    expect(resolveAmbassadorCustomerDiscount(15, PROGRAM_DEFAULT)).toBe(15);
  });

  it("inherits the program default when unset — never 0%", () => {
    expect(resolveAmbassadorCustomerDiscount(null, PROGRAM_DEFAULT)).toBe(10);
    expect(resolveAmbassadorCustomerDiscount(undefined, PROGRAM_DEFAULT)).toBe(10);
    expect(resolveAmbassadorCustomerDiscount("", PROGRAM_DEFAULT)).toBe(10);
  });

  it("honours a deliberate 0%", () => {
    expect(resolveAmbassadorCustomerDiscount(0, PROGRAM_DEFAULT)).toBe(0);
  });

  it("falls back rather than clamping a corrupt value", () => {
    for (const bad of [100, 150, -5, Number.NaN, "abc", {}]) {
      expect(resolveAmbassadorCustomerDiscount(bad, PROGRAM_DEFAULT)).toBe(10);
    }
  });

  // Connor: customers 10%, Connor 20%. The resolver cannot see any commission
  // rate at all -- a structural guarantee, not a coincidence of values.
  it("resolves the discount with no access to the commission rate", () => {
    expect(resolveAmbassadorCustomerDiscount.length).toBe(2);
    expect(resolveAmbassadorCustomerDiscount(10, PROGRAM_DEFAULT)).toBe(10);
  });

  it("one ambassador's rate cannot move another's", () => {
    expect(resolveAmbassadorCustomerDiscount(15, 10)).toBe(15);
    expect(resolveAmbassadorCustomerDiscount(5, 10)).toBe(5);
    expect(resolveAmbassadorCustomerDiscount(null, 10)).toBe(10);
  });

  it("a changed program default moves only those inheriting", () => {
    expect(resolveAmbassadorCustomerDiscount(null, 20)).toBe(20);
    expect(resolveAmbassadorCustomerDiscount(15, 20)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// A REFERRAL CODE COMPETING WITH OTHER DISCOUNTS.
// Existing rule, preserved: the single best discount wins. Never stacked.
// ---------------------------------------------------------------------------
describe("a referral code never stacks", () => {
  it("loses to a larger coupon", () => {
    const d = resolveCustomerDiscount(
      { ...CART, referralAccepted: true, referralPercent: 10, couponDiscount: 25 },
      ALL,
    );
    expect(d.amount).toBe(25);
    expect(d.components).toEqual(["coupon"]);
  });

  it("beats a smaller coupon", () => {
    const d = resolveCustomerDiscount(
      { ...CART, referralAccepted: true, referralPercent: 10, couponDiscount: 5 },
      ALL,
    );
    expect(d.amount).toBe(10.5);
    expect(d.components).toEqual(["referral"]);
  });

  it("loses to richer membership pricing", () => {
    const d = resolveCustomerDiscount(
      { ...CART, referralAccepted: true, referralPercent: 10, isMember: true, membershipPercent: 25 },
      ALL,
    );
    expect(d.amount).toBe(26.24); // 104.97 x 25% = 26.2425
  });

  it("contributes nothing on a bundle order", () => {
    const d = resolveCustomerDiscount(
      { ...CART, referralAccepted: true, referralPercent: 10, bundleDiscount: 20 },
      ALL,
    );
    expect(d.amount).toBe(20);
    expect(d.components).toEqual(["bundle"]);
  });

  it("never lets the customer save more than the subtotal", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal: 30, referralAccepted: true, referralPercent: 99 }, ALL);
    expect(d.amount).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// AN INVALID OR DISABLED CODE MUST NOT DISCOUNT OR PAY.
// ---------------------------------------------------------------------------
describe("invalid and disabled codes", () => {
  const webhook = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");
  const quote = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");

  it("an unaccepted code produces $0 discount", () => {
    const d = resolveCustomerDiscount({ ...CART, referralAccepted: false, referralPercent: 10 }, ALL);
    expect(d.amount).toBe(0);
  });

  it("checkout rejects any code whose ambassador is not approved", () => {
    expect(quote).toContain("That referral code is not active");
  });

  // Belt and braces: a stale code must not hard-block a legitimate sale.
  it("a code that went stale drops to null rather than failing the order", () => {
    expect(quote).toContain("referral = null;");
  });

  // Eligibility is re-checked at webhook time, so disabling mid-flight still
  // stops the commission on an order already in progress.
  it("the webhook re-checks live ambassador state and zeroes the commission", () => {
    expect(webhook).toContain('"Ambassador is not active."');
    expect(webhook).toContain("const commissionPercent = isIneligible ? 0 : effectiveCommission.percent;");
    expect(webhook).toContain("const commissionAmount = isIneligible ? 0 :");
  });

  it("the webhook also honours the program master switch and the pause", () => {
    expect(webhook).toContain('"Referral program is disabled."');
    expect(webhook).toContain('"Commissions are paused."');
  });
});

// ---------------------------------------------------------------------------
// REFUND ACCOUNTING. Real function, exact dollars.
// ---------------------------------------------------------------------------
describe("refund accounting", () => {
  it("a full refund retains $0", () => {
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 1 })).toBe(0);
  });

  it("a half refund retains exactly half", () => {
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 0.5 })).toBe(7.09);
  });

  it("a quarter refund retains three quarters", () => {
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 0.25 })).toBe(10.63);
  });

  it("no refund retains the whole commission", () => {
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 0 })).toBe(14.17);
  });

  // Recomputed from the STORED base each time, so two successive partials do
  // not compound off an already-reduced figure.
  it("successive partial refunds do not compound", () => {
    const first = computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 0.25 });
    const second = computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 0.5 });
    expect(first).toBe(10.63);
    expect(second).toBe(7.09); // half of the ORIGINAL, not half of 10.63
    expect(second).not.toBe(round(first * 0.5));
  });

  it("clamps a nonsense refunded fraction instead of inverting the commission", () => {
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: 2 })).toBe(0);
    expect(computeRetainedCommission({ base: 94.47, percent: 15, refundedFraction: -1 })).toBe(14.17);
  });

  // Money already sent cannot be clawed back by a status change.
  it("flags an already-paid commission for review rather than silently reversing", () => {
    expect(getCommissionStateForRefund("commission_paid").reviewRequired).toBe(true);
    expect(getCommissionStateForRefund("paid").reviewRequired).toBe(true);
    expect(getCommissionStateForRefund("pending").status).toBe("reversed");
    expect(getCommissionStateForRefund("pending").reviewRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COMMISSION CREATION AND DUPLICATE PROTECTION.
//
// These are DB-coupled, so they are verified against the source rather than by
// execution. Labeled honestly as such in the final report.
// ---------------------------------------------------------------------------
describe("commission creation is exactly-once", () => {
  const webhook = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

  it("claims paid side effects atomically, so a replayed webhook loses the race", () => {
    expect(webhook).toContain('.update({ paid_side_effects_at: new Date().toISOString() })');
    expect(webhook).toContain('.is("paid_side_effects_at", null)');
  });

  it("looks for an existing commission row before inserting one", () => {
    expect(webhook).toContain('.from("referral_orders")');
    expect(webhook).toContain("existingCommission");
  });

  it("computes commission on the DISCOUNTED merchandise subtotal", () => {
    expect(webhook).toContain("roundMoney(commissionableSubtotal * (commissionPercent / 100))");
  });

  it("gates on the PRE-discount subtotal, so a discount cannot disqualify a cart", () => {
    expect(webhook).toContain("qualifyingSubtotal < ambassadorSettings.minimumQualifyingOrder");
  });

  it("snapshots both rates onto every row that records a commission", () => {
    const rates = webhook.match(/commission_percent: commissionPercent,/g) ?? [];
    const snaps = webhook.match(/customer_discount_percent: customerDiscountPercent,/g) ?? [];
    expect(rates.length).toBe(3);
    expect(snaps.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BLAST-RADIUS GUARD.
//
// Ambassador logic must not be able to reach pricing, shipping, tax, inventory,
// fulfillment or the processor. The cheapest durable way to enforce that is to
// keep the shared rule in a module that imports nothing.
// ---------------------------------------------------------------------------
describe("ambassador logic stays contained", () => {
  const discountModule = readFileSync(join(process.cwd(), "src/lib/ambassador-discount.ts"), "utf8");
  const webhook = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");
  const portal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

  it("the shared rule imports nothing at all", () => {
    // Line-anchored: the file's own prose mentions importing.
    expect(/^import /m.test(discountModule)).toBe(false);
  });

  // The regression this replaced: the webhook importing quote-order dragged
  // catalog, tax, shipping, coupon and membership into its import graph.
  it("the payment webhook does not import the checkout pricing module", () => {
    expect(webhook).not.toContain("@/lib/quote-order");
    expect(portal).not.toContain("@/lib/quote-order");
  });

  it("ambassador code never touches product cost, tax, shipping or inventory", () => {
    for (const forbidden of ["product_cost_cents", "shipping_weight_oz", "quoteSalesTax", "calculateShipping"]) {
      expect(discountModule).not.toContain(forbidden);
    }
  });
});
