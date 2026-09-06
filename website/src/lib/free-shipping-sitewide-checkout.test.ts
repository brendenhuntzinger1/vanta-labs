import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// FREE SHIPPING SITEWIDE, THROUGH THE REAL CHECKOUT.
//
// free-shipping-sitewide.test.ts pins the formula. This file drives quoteOrder
// — the store's ONE authoritative pricing pass — because that is what decides
// the figure every downstream surface repeats:
//
//   payment authorization   quote.finalTotal        (payment-service.ts)
//   order record            orders.shipping_amount  (buildOrderRow)
//   confirmation email      reads that column       (order-confirmation-render)
//   admin order totals      reads that column       (admin/orders/[orderId])
//
// So an assertion here that the quote says $0 and the row it builds carries 0
// is an assertion about all four at once. The cart and checkout previews are
// covered by the formula test, since they call the same calculateShipping with
// the same config object handed to them by /api/catalog/promotions.
//
// The separation the switch has to keep is asserted just as hard: Shipping
// Protection goes on charging, and a free-shipping coupon is NOT recorded
// against an order whose shipping it did not have to waive.
// ---------------------------------------------------------------------------

const shippingState = vi.hoisted(() => ({ sitewide: false }));
const couponState = vi.hoisted(() => ({ freeShipping: false }));

vi.mock("@/lib/membership", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/membership");
  return {
    ...actual,
    getMembershipPerks: async () => ({
      isActiveMember: false, tierSlug: "free", memberDiscountPercent: 0,
      freeShipping: false, pointsPerDollar: 1, storeCreditBalanceCents: 0, storeCreditMinOrderCents: 0,
    }),
    getPointsBalance: async () => 0,
    isEligibleForBulkSavings: async () => false,
    isPriorityMember: async () => false,
  };
});

vi.mock("@/lib/supabase-server", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (onResolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
    return self;
  };
  const client = { from: () => chain(), rpc: async () => ({ data: null, error: null }) };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "peptide-a": { name: "Peptide A", category: "Research Peptides", price: "$100.00", stockStatus: "In Stock", image: "/a.png", description: "" },
} as const;

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
}));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: [],
      bundleStacking: false,
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    // The ONE thing under test: the real coded defaults ($15 domestic, free
    // over $200, 25/400 Canada, protection on) plus the switch.
    getShippingConfig: async () => ({ ...DEFAULT_SHIPPING_CONFIG, freeShippingSitewide: shippingState.sitewide }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: false }),
    getProfitSettings: async () => ({
      minProfitPercent: 0, minProfitDollars: -1e9, worstCaseUnitCost: 0,
      processingFeePercent: 0, processingFeeIncludesTax: true,
      countSalesTaxAsProfit: false, shippingCostPerOrder: 0,
    }),
    getPaymentMethodsConfig: async () => ([
      { id: "card", label: "Credit / Debit Card", kind: "card", enabled: true, order: 100, icon: "", recommended: false, badges: [], instructions: [] },
    ]),
  };
});

// A coupon whose ONLY benefit is free shipping — no percentage, no fixed
// amount. It is the cleanest probe for "did the switch get entangled with
// coupons": with shipping already free it waives nothing, so it must not be
// written to the order.
vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  return {
    ...actual,
    validateCoupon: async (code: string | undefined) => (code
      ? { code: "SHIPFREE", discountType: "fixed", discountValue: 0, discountAmount: 0, freeShipping: couponState.freeShipping }
      : null),
  };
});

const CUSTOMER = {
  email: "buyer@example.test",
  fullName: "Test Buyer",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

async function quote(input: {
  quantity?: number;
  country?: string;
  state?: string;
  shippingProtection?: boolean;
  couponCode?: string;
} = {}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: [{ id: "peptide-a", quantity: input.quantity ?? 1 }],
    customer: {
      ...CUSTOMER,
      country: input.country ?? CUSTOMER.country,
      state: input.state ?? CUSTOMER.state,
    },
    shippingProtection: input.shippingProtection,
    couponCode: input.couponCode,
    mode: "full",
  });
}

beforeEach(() => {
  vi.resetModules();
  shippingState.sitewide = false;
  couponState.freeShipping = false;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("switch OFF — the checkout prices exactly as it does today", () => {
  it("charges the domestic flat rate below the threshold", async () => {
    const quoted = await quote();
    expect(quoted.subtotal).toBe(100);
    expect(quoted.shipping).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
    expect(quoted.expectedTotal).toBe(100 + DEFAULT_SHIPPING_CONFIG.domesticFee);
  });

  it("still ships free once the threshold is crossed", async () => {
    const quoted = await quote({ quantity: 2 });
    expect(quoted.subtotal).toBe(200);
    expect(quoted.shipping).toBe(0);
  });

  it("still charges Canada its own rate", async () => {
    const quoted = await quote({ country: "Canada", state: "ON" });
    expect(quoted.shipping).toBe(DEFAULT_SHIPPING_CONFIG.northAmericaFee);
  });

  it("still records a free-shipping coupon that actually waived a fee", async () => {
    couponState.freeShipping = true;
    const quoted = await quote({ couponCode: "SHIPFREE" });
    expect(quoted.shipping).toBe(0);
    // The code did the work, so the order carries it and the redemption counts.
    expect(quoted.couponCode).toBe("SHIPFREE");
  });
});

describe("switch ON — every order ships free, everywhere the number travels", () => {
  beforeEach(() => { shippingState.sitewide = true; });

  it("quotes $0 shipping on a basket far below the threshold", async () => {
    const quoted = await quote();
    expect(quoted.subtotal).toBe(100);
    expect(quoted.shipping).toBe(0);
  });

  it("takes the fee out of the authorized total, not just off the display", async () => {
    shippingState.sitewide = false;
    const paid = await quote();
    shippingState.sitewide = true;
    const free = await quote();
    expect(paid.expectedTotal - free.expectedTotal).toBeCloseTo(DEFAULT_SHIPPING_CONFIG.domesticFee, 2);
    expect(free.finalTotal).toBe(free.expectedTotal);
    expect(free.expectedTotal).toBe(100);
  });

  it("ships Canada free too — every order, not just domestic ones", async () => {
    const quoted = await quote({ country: "Canada", state: "ON" });
    expect(quoted.shipping).toBe(0);
  });

  it("writes 0 to orders.shipping_amount, which is what the email and the admin totals read back", async () => {
    const quoted = await quote();
    const { buildOrderRow } = await import("@/lib/quote-order");
    const row = buildOrderRow({
      orderId: "ord_test", orderNumber: "VL-TEST", idempotencyKey: "idem", paymentId: null,
      paymentMethod: "card", cardProcessingFee: 0, cardProcessingFeePercent: 0,
      customer: CUSTOMER, currency: "USD",
      subtotal: quoted.subtotal,
      shippingAmount: quoted.shipping,
      taxAmount: quoted.taxAmount,
      discountAmount: quoted.discountAmount,
      shippingProtectionFee: quoted.shippingProtectionFee,
      bulkDiscountTier: null, priority: false, amountPaid: quoted.finalTotal,
      referralCode: null, ambassadorId: null, couponCode: null, customerUserId: null,
      pointsRedeemed: 0, storeCreditRedeemedCents: 0, taxRatePercent: 0, taxState: null,
    });
    expect(row.base.shipping_amount).toBe(0);
    expect(row.full.shipping_amount).toBe(0);
    expect(row.base.amount_paid).toBe(100);
  });

  it("renders $0.00 shipping on the confirmation email and the account/admin view of the same row", async () => {
    // Both surfaces read orders.shipping_amount rather than re-deriving
    // anything, so this is the end of the chain: one column, written from the
    // quote, repeated verbatim to the customer and to the operator.
    const quoted = await quote();
    const { buildOrderRow } = await import("@/lib/quote-order");
    const row = buildOrderRow({
      orderId: "ord_email", orderNumber: "VL-EMAIL", idempotencyKey: "idem-email", paymentId: null,
      paymentMethod: "card", cardProcessingFee: 0, cardProcessingFeePercent: 0,
      customer: CUSTOMER, currency: "USD",
      subtotal: quoted.subtotal, shippingAmount: quoted.shipping, taxAmount: quoted.taxAmount,
      discountAmount: quoted.discountAmount, shippingProtectionFee: quoted.shippingProtectionFee,
      bulkDiscountTier: null, priority: false, amountPaid: quoted.finalTotal,
      referralCode: null, ambassadorId: null, couponCode: null, customerUserId: null,
      pointsRedeemed: 0, storeCreditRedeemedCents: 0, taxRatePercent: 0, taxState: null,
    }).full;

    const { renderOrderConfirmationFromRecord } = await import("@/lib/email/order-confirmation-render");
    const email = renderOrderConfirmationFromRecord(
      { ...row, order_items: [{ product_name: "Peptide A", quantity: 1, line_total: 100 }] },
      "ord_email",
    );
    // The receipt states a shipping line, and it states it as free.
    expect(email.html).toMatch(/Shipping[\s\S]{0,200}\$0\.00/);
    expect(email.html).not.toContain("$15.00");

    // The admin order page and the account order list read the same column
    // straight off the row (`Number(order.shipping_amount ?? 0)`), which the
    // preceding test pins at 0 — there is no second derivation for them to
    // disagree with.
  });

  it("reports $0 shipping in the wallet sheet's own line items", async () => {
    // The express lane renders quote.displayLineItems verbatim, so a stale
    // shipping row here would show Apple Pay a fee the card is not charged.
    const quoted = await quote();
    const shippingLine = quoted.displayLineItems.find((line) => /shipping/i.test(line.label) && !/protection/i.test(line.label));
    expect(shippingLine === undefined || shippingLine.amountCents === 0).toBe(true);
  });
});

describe("switch ON — the things it must leave alone", () => {
  beforeEach(() => { shippingState.sitewide = true; });

  it("keeps charging Shipping Protection at its normal rate", async () => {
    const quoted = await quote({ shippingProtection: true });
    expect(quoted.shippingProtectionFee).toBeGreaterThan(0);
    // And it is genuinely IN the total the card is authorized for — free
    // shipping must not quietly make the add-on free as well.
    expect(quoted.expectedTotal).toBe(100 + quoted.shippingProtectionFee);
  });

  it("charges nothing for protection when the shopper declines it, exactly as before", async () => {
    const quoted = await quote({ shippingProtection: false });
    expect(quoted.shippingProtectionFee).toBe(0);
  });

  it("does not record a free-shipping coupon that waived nothing", async () => {
    // The switch already made shipping free, so the code took nothing off. It
    // must not be written to the order, redeemed, or counted — the same rule a
    // coupon beaten by a better discount already follows.
    couponState.freeShipping = true;
    const quoted = await quote({ couponCode: "SHIPFREE" });
    expect(quoted.shipping).toBe(0);
    expect(quoted.couponCode).toBeNull();
  });

  it("does not touch the merchandise subtotal or the discount", async () => {
    const quoted = await quote({ quantity: 2 });
    expect(quoted.subtotal).toBe(200);
    expect(quoted.discountAmount).toBe(0);
  });
});
