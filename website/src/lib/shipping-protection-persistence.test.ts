import { describe, expect, it } from "vitest";

import { buildOrderRow, type OrderRowInput } from "@/lib/quote-order";
import { expectedOrderTotal, isTotalMismatch, maxShippingProtectionFee } from "@/lib/reconciliation-math";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";

/**
 * Shipping Protection has to survive the trip from quote to database.
 *
 * It was charged — 4% of the merchandise subtotal, ticked by default — folded
 * into amount_paid, and stored in no column. Three real paid orders could not
 * reproduce their own totals:
 *
 *   VL-37C1E4B0   2.00 + 15.00        = 17.00, charged 17.08
 *   VL-8D132452   3.80 + 15.00        = 18.80, charged 18.95
 *   VL-E8F4D52F   54.99 + 15.00 + 3.85 = 73.84, charged 76.04
 *
 * Every gap is exactly 4% of that order's subtotal. Refunds were never affected
 * (they use amount_paid and the provider's own refund event), so no money moved
 * wrongly — but the books could not be read, and reconciliation had to tolerate
 * an unexplained overage up to the largest fee the order could have carried,
 * a band far too wide to tell a protection fee from a real overcharge.
 */

const baseInput: OrderRowInput = {
  orderId: "order-00000000-0000-4000-8000-000000000000",
  orderNumber: "VL-TESTONLY",
  idempotencyKey: "idem-test",
  paymentId: null,
  paymentMethod: "card",
  cardProcessingFee: 0,
  cardProcessingFeePercent: 0,
  customer: {
    fullName: "Test Person",
    email: "test@example.com",
    address: "1 Nowhere Lane",
    city: "Nowhere",
    postalCode: "00000",
    country: "US",
  } as OrderRowInput["customer"],
  currency: "USD",
  subtotal: 2,
  shippingAmount: 15,
  taxAmount: 0,
  discountAmount: 0,
  shippingProtectionFee: 0.08,
  bulkDiscountTier: null,
  priority: false,
  amountPaid: 17.08,
  referralCode: null,
  ambassadorId: null,
  couponCode: null,
  customerUserId: null,
  pointsRedeemed: 0,
  storeCreditRedeemedCents: 0,
  taxRatePercent: 0,
  taxState: null,
};

describe("the protection fee reaches the orders row", () => {
  it("writes shipping_protection_fee on the full column set", () => {
    const { full } = buildOrderRow(baseInput);
    expect(full.shipping_protection_fee).toBe(0.08);
  });

  it("writes a zero when the shopper unticked protection", () => {
    const { full } = buildOrderRow({ ...baseInput, shippingProtectionFee: 0, amountPaid: 17 });
    expect(full.shipping_protection_fee).toBe(0);
  });

  /**
   * The fee is passed in, never recomputed from subtotal here. Protection is
   * optional; deriving it inside buildOrderRow would bill every order for it in
   * the books whether or not the shopper actually paid it.
   */
  it("does NOT derive the fee from the subtotal", () => {
    const { full } = buildOrderRow({ ...baseInput, shippingProtectionFee: 0, amountPaid: 17 });
    expect(full.shipping_protection_fee).not.toBe(calculateShippingProtectionFee(2));
    expect(full.subtotal).toBe(2);
  });
});

describe("the invariant, on the real orders that broke it", () => {
  // subtotal + shipping + protection + handling + tax − discounts = amount_paid
  const reconciles = (o: {
    subtotal: number; shipping: number; protection: number; handling: number;
    tax: number; discount: number; cardFee: number; amountPaid: number;
  }) => {
    const total = expectedOrderTotal({
      subtotal: o.subtotal,
      shipping: o.shipping,
      tax: o.tax,
      cardFee: o.cardFee,
      discount: o.discount,
      storeCredit: 0,
      pointsDollars: 0,
      shippingProtection: o.protection,
    });
    return { total: Math.round((total + o.handling) * 100) / 100, amountPaid: o.amountPaid };
  };

  it.each([
    ["VL-37C1E4B0", 2.0, 15, 0, 0, 17.08],
    ["VL-8D132452", 3.8, 15, 0, 0, 18.95],
    ["VL-E8F4D52F", 54.99, 15, 3.85, 0, 76.04],
  ])("%s reconciles exactly once protection is counted", (_n, subtotal, shipping, tax, cardFee, amountPaid) => {
    const protection = calculateShippingProtectionFee(subtotal);
    const { total } = reconciles({ subtotal, shipping, protection, handling: 0, tax, discount: 0, cardFee, amountPaid });
    expect(total).toBe(amountPaid);
  });

  it("still fails when protection is left out — the defect itself", () => {
    const { total } = reconciles({
      subtotal: 2, shipping: 15, protection: 0, handling: 0, tax: 0, discount: 0, cardFee: 0, amountPaid: 17.08,
    });
    expect(total).not.toBe(17.08);
    expect(total).toBe(17.0);
  });
});

describe("reconciliation is exact once the fee is recorded", () => {
  const components = { subtotal: 54.99, shipping: 15, tax: 3.85, cardFee: 0, discount: 0, storeCredit: 0, pointsDollars: 0 };
  const protection = calculateShippingProtectionFee(54.99); // 2.20

  it("an allowance of 0 accepts the exactly-correct total", () => {
    const total = expectedOrderTotal({ ...components, shippingProtection: protection });
    expect(isTotalMismatch(76.04, total, 0)).toBe(false);
  });

  /**
   * The point of storing the fee. Under the old tolerance band this order could
   * be overcharged by up to its whole protection fee and reconciliation would
   * report nothing, because it could not tell that overage from the fee.
   */
  it("an allowance of 0 now CATCHES an overcharge the old band swallowed", () => {
    const total = expectedOrderTotal({ ...components, shippingProtection: protection });
    const overcharged = 76.04 + protection;
    expect(isTotalMismatch(overcharged, total, 0)).toBe(true);
    // Exactly what the legacy band did with the same order: silence.
    const legacyTotal = expectedOrderTotal(components);
    expect(isTotalMismatch(overcharged, legacyTotal, maxShippingProtectionFee(54.99) * 2)).toBe(false);
  });

  it("underpayment is still caught", () => {
    const total = expectedOrderTotal({ ...components, shippingProtection: protection });
    expect(isTotalMismatch(70, total, 0)).toBe(true);
  });

  /** A row from before the column exists must not start false-alarming. */
  it("keeps the legacy band usable for rows with no recorded fee", () => {
    const legacyTotal = expectedOrderTotal(components);
    expect(isTotalMismatch(76.04, legacyTotal, maxShippingProtectionFee(54.99))).toBe(false);
  });
});
