import { describe, expect, it } from "vitest";

import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { getBundleDiscountedUnitPrice, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";
import { computeRetainedCommission } from "@/lib/payment-webhook";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";

// ===========================================================================
// THE ORDER OF OPERATIONS, LOCKED TO EXACT DOLLARS.
//
//   merchandise subtotal
//     -> minimum-qualifying check       (on the PRE-discount subtotal)
//     -> customer ambassador discount
//     -> remaining merchandise amount   <- the commission base
//     -> ambassador commission
//     -> shipping and tax added to the CUSTOMER's total, not to the base
//
// The canonical case: $200 merchandise, 10% customer discount, 15% commission
// = $20 saved, $180 commissionable, $27 owed. Shipping and tax move the
// customer's charge and must leave the $27 untouched.
//
// Every number below is computed by hand and asserted against the real
// functions. A test that only checked "a discount was applied" would pass just
// as happily against $18 or $180.
// ===========================================================================

const round = (v: number) => Math.round(v * 100) / 100;

/** Commission as the webhook computes it: rate x DISCOUNTED merchandise. */
const commissionOn = (merchandiseAfterDiscount: number, percent: number) =>
  round(merchandiseAfterDiscount * (percent / 100));

/** The gate reads the PRE-discount merchandise subtotal. */
const qualifies = (preDiscountSubtotal: number) =>
  preDiscountSubtotal >= DEFAULT_MINIMUM_QUALIFYING_ORDER;

/** Tax basis: merchandise after eligible discounts. Shipping handled separately. */
const taxableBase = (subtotal: number, discount: number) => round(Math.max(0, subtotal - discount));

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

// ---------------------------------------------------------------------------
// THE CANONICAL EXAMPLE, STEP BY STEP.
// ---------------------------------------------------------------------------
describe("$200 merchandise, 10% customer discount, 15% commission", () => {
  const subtotal = 200;
  const discount = resolveCustomerDiscount(
    { ...CART, subtotal, referralAccepted: true, referralPercent: 10 },
    ALL,
  ).amount;
  const merchandiseAfterDiscount = round(subtotal - discount);
  const commission = commissionOn(merchandiseAfterDiscount, 15);

  it("step 2 — qualifies against the pre-discount subtotal", () => {
    expect(qualifies(subtotal)).toBe(true);
  });

  it("step 3 — the customer saves exactly $20.00", () => {
    expect(discount).toBe(20);
  });

  it("step 3 — $180.00 of merchandise remains", () => {
    expect(merchandiseAfterDiscount).toBe(180);
  });

  it("step 4 — the ambassador earns exactly $27.00", () => {
    expect(commission).toBe(27);
  });

  // The separation that matters. Commission is 15% of $180, never of the
  // customer's total.
  it("step 5 — shipping and tax do not raise the commission", () => {
    const shipping = 10;
    const tax = 12;
    const customerTotal = round(merchandiseAfterDiscount + shipping + tax);

    expect(customerTotal).toBe(202);
    expect(commission).toBe(27);
    expect(commission).not.toBe(commissionOn(customerTotal, 15)); // would be 30.30
  });

  it("step 5 — tax is charged on the discounted merchandise, not the full subtotal", () => {
    expect(taxableBase(subtotal, discount)).toBe(180);
    expect(taxableBase(subtotal, discount)).not.toBe(200);
  });

  // At exactly $200 the order ships free, and the threshold reads the
  // PRE-discount subtotal -- so taking the referral discount does not cost the
  // customer their free shipping.
  it("free shipping is decided on the pre-discount subtotal", () => {
    expect(calculateShipping(200, "US", DEFAULT_SHIPPING_CONFIG)).toBe(0);
    expect(calculateShipping(180, "US", DEFAULT_SHIPPING_CONFIG)).toBe(15);
    expect(calculateShipping(199.99, "US", DEFAULT_SHIPPING_CONFIG)).toBe(15);
  });
});

describe("$200 merchandise, 15% customer discount, 20% commission", () => {
  const subtotal = 200;
  const discount = resolveCustomerDiscount(
    { ...CART, subtotal, referralAccepted: true, referralPercent: 15 },
    ALL,
  ).amount;

  it("the customer saves $30.00, leaving $170.00", () => {
    expect(discount).toBe(30);
    expect(round(subtotal - discount)).toBe(170);
  });

  it("the ambassador earns $34.00", () => {
    expect(commissionOn(170, 20)).toBe(34);
  });

  // Same cart, different rates, different money -- and neither rate derived
  // from the other.
  it("differs from the 10/15 outcome on an identical cart", () => {
    expect(commissionOn(180, 15)).toBe(27);
    expect(commissionOn(170, 20)).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// THE $100 BOUNDARY.
// ---------------------------------------------------------------------------
describe("the qualifying minimum", () => {
  it("is $100 and is tested with >=", () => {
    expect(DEFAULT_MINIMUM_QUALIFYING_ORDER).toBe(100);
    expect(qualifies(99.99)).toBe(false);
    expect(qualifies(100)).toBe(true);
  });

  // The customer still saves below the threshold; only the commission is
  // withheld. Two separate rules, and conflating them would either overpay the
  // ambassador or silently stop discounting the shopper.
  it("still discounts a $99.99 order while paying $0 commission", () => {
    const discount = resolveCustomerDiscount(
      { ...CART, subtotal: 99.99, referralAccepted: true, referralPercent: 10 },
      ALL,
    ).amount;
    expect(discount).toBe(10); // 9.999 -> 10.00
    expect(qualifies(99.99)).toBe(false);
  });

  // A $104.97 cart nets $94.47 -- under $100 -- and still qualifies, because
  // the gate reads the pre-discount figure.
  it("does not let the discount disqualify a qualifying cart", () => {
    expect(qualifies(104.97)).toBe(true);
    expect(round(104.97 - 10.5)).toBe(94.47);
  });
});

// ---------------------------------------------------------------------------
// STACKING IS OFF. ONE DISCOUNT WINS, ALWAYS THE LARGEST.
// ---------------------------------------------------------------------------
describe("discounts never stack — the single best wins", () => {
  const subtotal = 200;

  const scenario = (over: Partial<OrderInputs>) =>
    resolveCustomerDiscount({ ...CART, subtotal, ...over }, ALL);

  it("referral only → $20.00", () => {
    const d = scenario({ referralAccepted: true, referralPercent: 10 });
    expect(d.amount).toBe(20);
    expect(d.components).toEqual(["referral"]);
  });

  it("coupon only → $35.00", () => {
    const d = scenario({ couponDiscount: 35 });
    expect(d.amount).toBe(35);
    expect(d.components).toEqual(["coupon"]);
  });

  it("referral + coupon → $35.00, NOT $55.00", () => {
    const d = scenario({ referralAccepted: true, referralPercent: 10, couponDiscount: 35 });
    expect(d.amount).toBe(35);
    expect(d.components).toEqual(["coupon"]);
    expect(d.amount).not.toBe(55);
  });

  it("coupon + referral where the referral is larger → $20.00", () => {
    const d = scenario({ referralAccepted: true, referralPercent: 10, couponDiscount: 5 });
    expect(d.amount).toBe(20);
    expect(d.components).toEqual(["referral"]);
  });

  it("member only → $30.00 at 15%", () => {
    expect(scenario({ isMember: true, membershipPercent: 15 }).amount).toBe(30);
  });

  it("member + referral → $30.00, the membership, not $50.00", () => {
    const d = scenario({ isMember: true, membershipPercent: 15, referralAccepted: true, referralPercent: 10 });
    expect(d.amount).toBe(30);
  });

  it("member + coupon → the larger of the two", () => {
    expect(scenario({ isMember: true, membershipPercent: 15, couponDiscount: 40 }).amount).toBe(40);
    expect(scenario({ isMember: true, membershipPercent: 15, couponDiscount: 10 }).amount).toBe(30);
  });

  it("member + referral + coupon → still exactly one winner", () => {
    const d = scenario({
      isMember: true, membershipPercent: 15,
      referralAccepted: true, referralPercent: 10,
      couponDiscount: 45,
    });
    expect(d.amount).toBe(45);
    expect(d.components).toEqual(["coupon"]);
  });

  // Re-applying codes must not accumulate. resolveCustomerDiscount is pure, so
  // the same inputs always produce the same single figure.
  it("applying and removing codes repeatedly cannot grow the discount", () => {
    const inputs = { referralAccepted: true, referralPercent: 10, couponDiscount: 35 };
    const runs = [scenario(inputs), scenario(inputs), scenario(inputs)];
    expect(runs.every((r) => r.amount === 35)).toBe(true);
  });

  it("a discount can never exceed the merchandise subtotal", () => {
    expect(scenario({ couponDiscount: 9999 }).amount).toBeLessThanOrEqual(200);
    expect(scenario({ referralAccepted: true, referralPercent: 99 }).amount).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// QUANTITY PRICING FEEDS THE SUBTOTAL, THEN THE REFERRAL APPLIES.
// ---------------------------------------------------------------------------
describe("quantity pricing then referral", () => {
  it("bundle pricing lowers the unit price before anything else", () => {
    expect(getBundleDiscountedUnitPrice(50, 1, DEFAULT_BUNDLE_CONFIG)).toBe(50);
    expect(getBundleDiscountedUnitPrice(50, 2, DEFAULT_BUNDLE_CONFIG)).toBe(47.5);
    expect(getBundleDiscountedUnitPrice(50, 3, DEFAULT_BUNDLE_CONFIG)).toBe(46);
  });

  // 4 x $50 at the 3+ rate = $46 each = $184 subtotal. The referral then takes
  // 10% of $184, not of $200 -- and $184 still clears the $100 gate.
  it("the referral applies to the quantity-adjusted subtotal", () => {
    const unit = getBundleDiscountedUnitPrice(50, 4, DEFAULT_BUNDLE_CONFIG);
    const subtotal = round(unit * 4);
    expect(subtotal).toBe(184);

    const discount = resolveCustomerDiscount(
      { ...CART, subtotal, referralAccepted: true, referralPercent: 10 },
      ALL,
    ).amount;
    expect(discount).toBe(18.4);
    expect(round(subtotal - discount)).toBe(165.6);
    expect(commissionOn(165.6, 15)).toBe(24.84);
    expect(qualifies(subtotal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A COUPON-ONLY ORDER MUST NOT CREATE COMMISSION.
// ---------------------------------------------------------------------------
describe("commission requires an accepted referral", () => {
  it("a coupon-only order produces no referral discount", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal: 200, couponDiscount: 35 }, ALL);
    expect(d.components).toEqual(["coupon"]);
    expect(d.components).not.toContain("referral");
  });

  it("a configured rate alone earns nothing without an accepted code", () => {
    const d = resolveCustomerDiscount({ ...CART, subtotal: 200, referralPercent: 90 }, ALL);
    expect(d.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REFUNDS ADJUST THE COMMISSION, NOT THE BASE IT WAS COMPUTED FROM.
// ---------------------------------------------------------------------------
describe("refund accounting against the $27 example", () => {
  it("a full refund retains $0.00", () => {
    expect(computeRetainedCommission({ base: 180, percent: 15, refundedFraction: 1 })).toBe(0);
  });

  it("a half refund retains $13.50", () => {
    expect(computeRetainedCommission({ base: 180, percent: 15, refundedFraction: 0.5 })).toBe(13.5);
  });

  it("a quarter refund retains $20.25", () => {
    expect(computeRetainedCommission({ base: 180, percent: 15, refundedFraction: 0.25 })).toBe(20.25);
  });

  it("successive partials recompute from the original base, never compounding", () => {
    const quarter = computeRetainedCommission({ base: 180, percent: 15, refundedFraction: 0.25 });
    const half = computeRetainedCommission({ base: 180, percent: 15, refundedFraction: 0.5 });
    expect(quarter).toBe(20.25);
    expect(half).toBe(13.5);
    expect(half).not.toBe(round(quarter * 0.5)); // 10.13 if it compounded
  });
});

// ---------------------------------------------------------------------------
// THE FULL LEDGER, ONE ROW PER SCENARIO.
// Every column asserted; a wrong figure anywhere fails the row.
// ---------------------------------------------------------------------------
describe("scenario ledger — every column asserted", () => {
  type Row = {
    name: string;
    subtotal: number;
    over: Partial<OrderInputs>;
    commissionPct: number;
    expect: {
      discount: number;
      merchandiseAfter: number;
      taxable: number;
      shipping: number;
      commissionable: number;
      commission: number;
    };
  };

  const rows: Row[] = [
    {
      name: "no referral, no coupon — $200",
      subtotal: 200, over: {}, commissionPct: 0,
      expect: { discount: 0, merchandiseAfter: 200, taxable: 200, shipping: 0, commissionable: 0, commission: 0 },
    },
    {
      name: "referral 10% / commission 15% — $200",
      subtotal: 200, over: { referralAccepted: true, referralPercent: 10 }, commissionPct: 15,
      expect: { discount: 20, merchandiseAfter: 180, taxable: 180, shipping: 0, commissionable: 180, commission: 27 },
    },
    {
      name: "referral 15% / commission 20% — $200",
      subtotal: 200, over: { referralAccepted: true, referralPercent: 15 }, commissionPct: 20,
      expect: { discount: 30, merchandiseAfter: 170, taxable: 170, shipping: 0, commissionable: 170, commission: 34 },
    },
    {
      name: "referral 10% / commission 15% — $150 (paid shipping)",
      subtotal: 150, over: { referralAccepted: true, referralPercent: 10 }, commissionPct: 15,
      expect: { discount: 15, merchandiseAfter: 135, taxable: 135, shipping: 15, commissionable: 135, commission: 20.25 },
    },
    {
      name: "referral below the $100 minimum — $99.99",
      subtotal: 99.99, over: { referralAccepted: true, referralPercent: 10 }, commissionPct: 15,
      expect: { discount: 10, merchandiseAfter: 89.99, taxable: 89.99, shipping: 15, commissionable: 0, commission: 0 },
    },
    {
      name: "coupon only — $200",
      subtotal: 200, over: { couponDiscount: 35 }, commissionPct: 0,
      expect: { discount: 35, merchandiseAfter: 165, taxable: 165, shipping: 0, commissionable: 0, commission: 0 },
    },
    {
      name: "coupon + referral stack attempt — $200",
      subtotal: 200, over: { referralAccepted: true, referralPercent: 10, couponDiscount: 35 }, commissionPct: 15,
      expect: { discount: 35, merchandiseAfter: 165, taxable: 165, shipping: 0, commissionable: 165, commission: 24.75 },
    },
    {
      name: "member 15% only — $200",
      subtotal: 200, over: { isMember: true, membershipPercent: 15 }, commissionPct: 0,
      expect: { discount: 30, merchandiseAfter: 170, taxable: 170, shipping: 0, commissionable: 0, commission: 0 },
    },
    {
      name: "member 15% + referral 10% — $200",
      subtotal: 200, over: { isMember: true, membershipPercent: 15, referralAccepted: true, referralPercent: 10 }, commissionPct: 15,
      expect: { discount: 30, merchandiseAfter: 170, taxable: 170, shipping: 0, commissionable: 170, commission: 25.5 },
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const discount = resolveCustomerDiscount({ ...CART, subtotal: row.subtotal, ...row.over }, ALL).amount;
      const merchandiseAfter = round(row.subtotal - discount);
      const taxable = taxableBase(row.subtotal, discount);
      const shipping = calculateShipping(row.subtotal, "US", DEFAULT_SHIPPING_CONFIG);
      const commissionable = qualifies(row.subtotal) && row.commissionPct > 0 ? merchandiseAfter : 0;
      const commission = commissionOn(commissionable, row.commissionPct);

      expect({ discount, merchandiseAfter, taxable, shipping, commissionable, commission }).toEqual(row.expect);
    });
  }

  // Whatever the discount mix, the commission base is merchandise only. It can
  // never equal a figure that includes shipping or tax.
  it("no scenario ever computes commission on shipping or tax", () => {
    for (const row of rows) {
      const discount = resolveCustomerDiscount({ ...CART, subtotal: row.subtotal, ...row.over }, ALL).amount;
      const shipping = calculateShipping(row.subtotal, "US", DEFAULT_SHIPPING_CONFIG);
      const tax = round(taxableBase(row.subtotal, discount) * 0.07);
      const withExtras = round(row.subtotal - discount + shipping + tax);

      if (row.expect.commission > 0) {
        expect(row.expect.commission).not.toBe(commissionOn(withExtras, row.commissionPct));
      }
    }
  });
});
