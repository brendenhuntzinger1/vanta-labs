import { beforeEach, describe, expect, it, vi } from "vitest";
import { OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { WELCOME_GIFT_OFFER_KEY } from "@/lib/offers/welcome-offer-terms";

// ---------------------------------------------------------------------------
// THE WELCOME OFFER IS THE FREE VIAL OR THE 15% CODE, NEVER BOTH.
//
// A new subscriber holds both halves (welcome-gift.ts and codes.ts mint them
// together). Driven through the real quoteOrder:
//   * the vial alone applies as a $0 line on an order over its floor;
//   * a WELCOME code typed on the same order withdraws the vial, the code
//     prices the order, and the quote names the reason so the checkout can;
//   * any OTHER code stacks with the vial exactly as every product gift always
//     has, because only a code whose source names the welcome offer counts;
//   * the owner's synthetic first-order code (source "welcome_offer") is a
//     welcome code too.
// ---------------------------------------------------------------------------

type OfferRow = {
  id: string; offer_key: string; email: string; reward_kind: string;
  product_slug: string | null; percent_off: number | null; variant_id: string | null;
  min_subtotal_cents: number; expires_at: string; reserved_order_id: string | null; redeemed_at: string | null;
};

const state = vi.hoisted(() => ({
  offer: null as OfferRow | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    peekCustomerOffer: async (input: { token: string; email: string }) =>
      state.offer && state.offer.email === input.email.toLowerCase() ? state.offer : null,
  };
});

/** Three codes, no database: the minted welcome code, the owner's synthetic one, an ordinary one. */
vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  const calculate = actual.calculateCouponDiscount as (subtotal: number, type: "percent" | "fixed", value: number) => number;
  const CODES: Record<string, { percent: number; source: string | null }> = {
    "VLWELCOME-ABC234": { percent: 15, source: "omnisend_welcome" },
    WELCOME10: { percent: 10, source: "welcome_offer" },
    SAVE10: { percent: 10, source: null },
  };
  return {
    ...actual,
    validateCoupon: async (code: string | undefined, subtotal: number) => {
      const key = String(code ?? "").trim().toUpperCase();
      const found = CODES[key];
      if (!found) throw new Error("Invalid coupon code.");
      return { code: key, discountType: "percent", discountValue: found.percent, discountAmount: calculate(subtotal, "percent", found.percent), freeShipping: false, source: found.source };
    },
  };
});

vi.mock("@/lib/rewards", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/rewards");
  return {
    ...actual,
    getMembershipPerks: async () => ({
      isActiveMember: false, tierSlug: "free", memberDiscountPercent: 0, freeShipping: false,
      pointsPerDollar: 1, storeCreditBalanceCents: 0, storeCreditMinOrderCents: 0,
    }),
    getPointsBalance: async () => 0,
    isEligibleForBulkSavings: async () => false,
    isPriorityMember: async () => false,
  };
});

vi.mock("@/lib/supabase-server", () => {
  const rpc = async (fn: string) => {
    if (fn === "bxgy_count_redemptions") return { data: 0, error: null };
    if (fn === "bxgy_claim_redemption") return { data: true, error: null };
    if (fn === "bxgy_release_redemption") return { data: true, error: null };
    return { data: null, error: null };
  };
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) self[method] = () => self;
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (onResolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
    return self;
  };
  const auth = {
    admin: {
      getUserById: async () => ({ data: { user: null }, error: null }),
      listUsers: async () => ({ data: { users: [] }, error: null }),
    },
  };
  const client = { from: () => chain(), rpc, auth };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "peptide-b": { name: "Peptide B", category: "Research Peptides", price: "$40.00", stockStatus: "In Stock", image: "/b.png", description: "" },
  "ghk-cu": { name: "GHK-Cu", category: "Research Peptides", price: "$39.99", stockStatus: "In Stock", image: "/g.png", description: "" },
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
    getHomepageControlConfig: async () => ({ bxgyPromotions: [], bundleStacking: false, bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 } }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({
      domesticFee: 15, freeShippingThreshold: 200,
      northAmericaFee: 25, northAmericaFreeShippingThreshold: 400,
      internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0,
    }),
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

const CUSTOMER = {
  email: "new@example.test", fullName: "New Subscriber", address: "1 Test Street",
  city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100",
};

const welcomeVial = (): OfferRow => ({
  id: "offer-w", offer_key: WELCOME_GIFT_OFFER_KEY, email: CUSTOMER.email, reward_kind: "free_product",
  product_slug: "ghk-cu", percent_off: null, variant_id: null,
  min_subtotal_cents: OFFER_CATALOG[WELCOME_GIFT_OFFER_KEY].minSubtotalCents,
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), reserved_order_id: null, redeemed_at: null,
});

async function quote(items: Array<{ id: string; quantity: number }>, opts: { couponCode?: string } = {}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({ items, customer: CUSTOMER, offerToken: "token", mode: "full", couponCode: opts.couponCode });
}

const giftLines = (q: { lineItems: Array<{ gift?: boolean; product: { name: string } }> }) =>
  q.lineItems.filter((line) => line.gift).map((line) => line.product.name);

beforeEach(() => {
  vi.resetModules();
  state.offer = welcomeVial();
});

describe("the welcome vial on its own", () => {
  it("is added as a $0 line on a first order over its floor, and the quote names no withdrawal", async () => {
    const q = await quote([{ id: "peptide-b", quantity: 2 }]);
    expect(giftLines(q)).toEqual(["GHK-Cu"]);
    expect(q.appliedOffer?.productApplied).toBe(true);
    expect(q.offerWithdrawnBy).toBeNull();
    expect(q.discountAmount).toBe(0);
  });
});

describe("a welcome code typed over the welcome vial", () => {
  it("withdraws the vial, prices the code, and says why", async () => {
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "VLWELCOME-ABC234" });
    expect(giftLines(q)).toEqual([]);
    expect(q.appliedOffer).toBeNull();
    expect(q.offerWithdrawnBy).toBe("welcome_code");
    expect(q.couponCode).toBe("VLWELCOME-ABC234");
    expect(q.discountAmount).toBe(12);
    // The chosen units are untouched: nothing borrowed, nothing lost.
    expect(q.lineItems.map((line) => [line.product.name, line.quantity])).toEqual([["Peptide B", 2]]);
  });

  it("treats the owner's synthetic first-order code as a welcome code too", async () => {
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "WELCOME10" });
    expect(giftLines(q)).toEqual([]);
    expect(q.offerWithdrawnBy).toBe("welcome_code");
    expect(q.discountAmount).toBe(8);
  });
});

describe("any other code beside the welcome vial", () => {
  it("stacks with it: the vial stays and the code prices the order", async () => {
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SAVE10" });
    expect(giftLines(q)).toEqual(["GHK-Cu"]);
    expect(q.appliedOffer?.productApplied).toBe(true);
    expect(q.offerWithdrawnBy).toBeNull();
    expect(q.discountAmount).toBe(8);
  });

  it("is a floor question, not a choice, when the discounted basket falls under the vial's minimum", async () => {
    // $60 of goods, 10% off: $54 qualifying, under the $60 floor. The vial
    // comes out for the floor, and the quote must NOT call that a choice.
    const q = await quote([{ id: "peptide-b", quantity: 1 }, { id: "ghk-cu", quantity: 1 }], { couponCode: "SAVE10" });
    // The point of this test is that the shopper is never told their CODE
    // displaced the vial when the basket was simply too small — blaming the
    // code for a floor is the same class of mistake as blaming the email
    // address for one.
    expect(q.offerWithdrawnBy).not.toBe("welcome_code");
    // It used to assert null, which said "not a choice" by saying nothing at
    // all — and nothing at all is also what a quote with no offer on it says,
    // so no surface could tell the two apart. The floor now names itself, and
    // carries the figure that closes it.
    expect(q.offerWithdrawnBy).toBe("minimum");
    expect(q.offerShortfallCents).toBeGreaterThan(0);
  });
});

describe("a welcome code with a different gift on the cookie", () => {
  it("leaves a win-back vial alone: only the welcome vial is the welcome code's alternative", async () => {
    state.offer = { ...welcomeVial(), offer_key: "winback_60_free_ghkcu" };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "VLWELCOME-ABC234" });
    expect(giftLines(q)).toEqual(["GHK-Cu"]);
    expect(q.offerWithdrawnBy).toBeNull();
  });
});
