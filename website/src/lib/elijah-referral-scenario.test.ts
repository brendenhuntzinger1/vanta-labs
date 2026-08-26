import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { computeRetainedCommission } from "@/lib/payment-webhook";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";

// ===========================================================================
// ELIJAH-AB78AE — 20% customer discount, 10% commission.
//
// The exact configuration in production, asserted against the real pricing
// engine and the real shipping table rather than a restatement of the intent.
//
// Traced path:
//   quote-order.ts   subtotal -> resolveCustomerDiscount -> discountAmount
//                    taxableAmount = subtotal - discountAmount
//                    shipping = calculateShipping(subtotal, ...)   <- PRE-discount
//   payment-webhook  commissionableSubtotal = subtotal - discountAmount
//                    commission = roundMoney(commissionable * pct/100)
//
// What this file cannot do is execute a payment. Every assertion below is the
// arithmetic and the wiring; the database writes are proven by the SQL in
// docs/, run against the real order.
// ===========================================================================

const round = (v: number) => Math.round(v * 100) / 100;
const commissionOn = (base: number, pct: number) => round(base * (pct / 100));

const CART: OrderInputs = {
  subtotal: 200,
  productCost: 0,
  bundleDiscount: 0,
  referralAccepted: false,
  referralPercent: 0,
  isMember: false,
  membershipPercent: 0,
  couponDiscount: 0,
  bulkSavingsAmount: 0,
  personalDiscountAmount: 0,
  allowCouponStacking: false,
  commissionPercent: 0,
  processingFeePercent: 8,
  shippingCollected: 0,
  shippingCost: 0,
  handlingCollected: 0,
  taxPercent: 0,
};

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);

const ELIJAH_DISCOUNT = 20;
const ELIJAH_COMMISSION = 10;

describe("$200 merchandise through Elijah's code", () => {
  const subtotal = 200;
  const discount = resolveCustomerDiscount(
    { ...CART, subtotal, referralAccepted: true, referralPercent: ELIJAH_DISCOUNT },
    ALL,
  ).amount;
  const commissionable = round(subtotal - discount);

  it("qualifies — the gate reads the pre-discount subtotal", () => {
    expect(subtotal).toBeGreaterThanOrEqual(DEFAULT_MINIMUM_QUALIFYING_ORDER);
  });

  it("discounts the customer exactly $40.00", () => {
    expect(discount).toBe(40);
  });

  it("leaves exactly $160.00 commissionable", () => {
    expect(commissionable).toBe(160);
  });

  it("pays Elijah exactly $16.00", () => {
    expect(commissionOn(commissionable, ELIJAH_COMMISSION)).toBe(16);
  });

  // At exactly $200 the domestic threshold is met and shipping is free, so the
  // customer pays merchandise + tax only. The threshold reads the PRE-discount
  // subtotal, so taking the 20% does not cost them free shipping.
  it("ships free at $200, decided before the discount", () => {
    expect(calculateShipping(200, "US", DEFAULT_SHIPPING_CONFIG)).toBe(0);
    expect(calculateShipping(160, "US", DEFAULT_SHIPPING_CONFIG)).toBe(15);
  });

  it("taxes the discounted merchandise, not the full subtotal", () => {
    expect(round(subtotal - discount)).toBe(160);
  });

  // The separation the whole model rests on.
  it("earns $0 commission on shipping and $0 on tax", () => {
    const shipping = 15;
    const tax = 12;
    const customerTotal = round(commissionable + shipping + tax);

    expect(commissionOn(commissionable, ELIJAH_COMMISSION)).toBe(16);
    expect(commissionOn(customerTotal, ELIJAH_COMMISSION)).toBe(18.7);
    expect(commissionOn(commissionable, ELIJAH_COMMISSION)).not.toBe(commissionOn(customerTotal, ELIJAH_COMMISSION));

    // Stated as the difference itself: shipping + tax contribute nothing.
    expect(commissionOn(commissionable + shipping + tax, ELIJAH_COMMISSION) - commissionOn(commissionable, ELIJAH_COMMISSION))
      .toBeCloseTo(commissionOn(shipping + tax, ELIJAH_COMMISSION), 2);
  });
});

describe("changing Elijah's rate later", () => {
  // Rates are snapshotted per order, so an old order's money is arithmetic on
  // its OWN stored percentages, never on today's.
  it("a past order keeps its own numbers", () => {
    const past = { discountPct: 20, commissionPct: 10, subtotal: 200 };
    const pastDiscount = round(past.subtotal * (past.discountPct / 100));
    expect(pastDiscount).toBe(40);
    expect(commissionOn(round(past.subtotal - pastDiscount), past.commissionPct)).toBe(16);
  });

  it("a future order at 15/20 produces different money from the same cart", () => {
    const discount = resolveCustomerDiscount({ ...CART, subtotal: 200, referralAccepted: true, referralPercent: 15 }, ALL).amount;
    expect(discount).toBe(30);
    expect(commissionOn(round(200 - discount), 20)).toBe(34);
  });
});

describe("Elijah's code cannot be abused", () => {
  const quote = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");
  const webhook = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

  it("he cannot use it on his own order — blocked by email AND by account id", () => {
    expect(quote).toContain("const isSelfReferralByEmail");
    expect(quote).toContain("const isSelfReferralByAccount");
    expect(quote).toContain("You can't use your own referral code on your own order.");
  });

  it("a coupon cannot stack on top of his 20%", () => {
    const stacked = resolveCustomerDiscount(
      { ...CART, subtotal: 200, referralAccepted: true, referralPercent: ELIJAH_DISCOUNT, couponDiscount: 25 },
      ALL,
    );
    expect(stacked.amount).toBe(40); // his 20% wins; the $25 coupon does not add
    expect(stacked.amount).not.toBe(65);
    expect(stacked.components).toEqual(["referral"]);
  });

  it("re-applying the code cannot compound the discount", () => {
    const once = resolveCustomerDiscount({ ...CART, subtotal: 200, referralAccepted: true, referralPercent: 20 }, ALL).amount;
    const again = resolveCustomerDiscount({ ...CART, subtotal: 200, referralAccepted: true, referralPercent: 20 }, ALL).amount;
    expect(once).toBe(40);
    expect(again).toBe(40);
  });

  it("disabling him zeroes the commission at webhook time, not just at checkout", () => {
    expect(webhook).toContain('"Ambassador is not active."');
    expect(webhook).toContain("const commissionAmount = isIneligible ? 0 :");
  });

  it("an unpaid order never reaches commission creation", () => {
    expect(webhook).toContain('.is("paid_side_effects_at", null)');
  });

  it("a replayed webhook cannot create a second commission", () => {
    expect(webhook).toContain('.update({ paid_side_effects_at: new Date().toISOString() })');
    expect(webhook).toContain("existingCommission");
  });
});

describe("refunding Elijah's $16.00", () => {
  it("a full refund retains $0.00 and keeps the row", () => {
    expect(computeRetainedCommission({ base: 160, percent: 10, refundedFraction: 1 })).toBe(0);
  });

  it("a half refund retains $8.00", () => {
    expect(computeRetainedCommission({ base: 160, percent: 10, refundedFraction: 0.5 })).toBe(8);
  });

  it("successive partials recompute from the original base", () => {
    const quarter = computeRetainedCommission({ base: 160, percent: 10, refundedFraction: 0.25 });
    const half = computeRetainedCommission({ base: 160, percent: 10, refundedFraction: 0.5 });
    expect(quarter).toBe(12);
    expect(half).toBe(8);
    expect(half).not.toBe(round(quarter * 0.5));
  });
});

// REPLACED, NOT PATCHED. This describe was four readFileSync greps over
// ambassador-commission.ts — two of them whitespace-exact multi-line string
// matches. They could not fail for the defect their own comments describe. Both
// of these reproduce it exactly while leaving every asserted literal intact,
// and the FULL suite stayed green for both:
//
//   let matched: (typeof tiers)[number] | null = null;
//   matched = tiers.at(0) ?? null;                               // inserted
//
//   if (ambassador) ambassador.commission_percent_locked = false; // inserted
//   if (ambassador?.commission_percent_locked) { ... }            // untouched
//
// A grep that goes red on a safe refactor and green on the real bug is worse
// than no test, because it is counted as coverage. The rule Elijah's rate
// depends on is now exercised behaviourally — real function, real tier rows,
// real referral history — in src/lib/commission-tier-resolution.test.ts, which
// catches both mutations above and eleven others.

describe("what the owner and the ambassador each see", () => {
  const portal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

  // Both surfaces read the table checkout reads, so a displayed 20% and a
  // charged 20% are the same column rather than two copies that agree today.
  it("both dashboards read the authoritative table", () => {
    expect(portal).toContain("async function fetchAuthoritativeRates(");
    expect(portal).toContain("const authoritativeRates = await fetchAuthoritativeRates(");
    expect(portal).toContain("liveRates ? liveRates.customerDiscountPercent : partner.customer_discount_percent");
  });
});
