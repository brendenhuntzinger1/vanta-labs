import { beforeEach, describe, expect, it, vi } from "vitest";
import { OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { WELCOME_GIFT_OFFER_KEY } from "@/lib/offers/welcome-offer-terms";

// ---------------------------------------------------------------------------
// "CANNOT BE COMBINED WITH OTHER OFFERS" HAS TO BE TRUE, NOT HOPEFUL.
//
// From 2026-09-16 that sentence is printed beside the welcome code on four
// storefront surfaces (the catalogue bar, the product-page link, the cart card
// and the checkout box, all from welcome-offer-copy.ts). Coupon stacking is a
// store-wide admin toggle, and a promotion can licence a stack of its own, so
// with either one switched on the engine would happily have added a welcome
// code on top of another discount and made the printed terms a lie.
//
// This file switches stacking ON — the hostile setting — and drives the real
// quoteOrder to show:
//   * an ordinary code still stacks, so the switch is genuinely on;
//   * a welcome code does NOT, and the order pays the better single discount;
//   * the owner's synthetic first-order code behaves the same way, because it
//     is a welcome code too (welcome-offer-terms.ts WELCOME_CODE_SOURCES).
//
// Bulk savings stand in for "another offer" here: they need no extra mocking
// and land in the same single-best-discount contest as everything else.
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
    isEligibleForBulkSavings: async () => true,
    isPriorityMember: async () => false,
  };
});

// The competing offer: an approved ambassador's own 20% off their own order.
// It lands in the same single-best-discount contest as a promotion or a
// referral would, and unlike a quantity bundle it does not touch line prices,
// so the arithmetic below is only ever about the discount buckets.
vi.mock("@/lib/ambassador-status", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ambassador-status");
  return { ...actual, isApprovedAmbassadorCustomer: async () => true };
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
    getBulkSavingsControlConfig: async () => ({ enabled: true, tier1Threshold: 50, tier1Percent: 20, tier2Threshold: 800, tier2Percent: 25 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({
      domesticFee: 15, freeShippingThreshold: 200,
      northAmericaFee: 25, northAmericaFreeShippingThreshold: 400,
      internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0,
    }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 20, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: true }),
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
  email: "stacker@example.test", fullName: "Stack Tester", address: "1 Test Street",
  city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100",
};

async function quote(opts: { couponCode?: string } = {}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: [{ id: "peptide-b", quantity: 2 }],
    customer: CUSTOMER,
    mode: "full",
    couponCode: opts.couponCode,
  });
}

beforeEach(() => {
  vi.resetModules();
  // No vial in play: this file is about the code and the stacking switch.
  state.offer = null;
  void OFFER_CATALOG;
  void WELCOME_GIFT_OFFER_KEY;
});

describe("with store-wide coupon stacking ON", () => {
  it("still stacks an ordinary code on top of the other discount, so the switch is provably on", async () => {
    const bare = await quote();
    const stacked = await quote({ couponCode: "SAVE10" });
    // $80 of product, 10% code = $8, added to whatever already applied.
    expect(bare.discountAmount).toBeGreaterThan(0);
    expect(stacked.discountAmount).toBeCloseTo(bare.discountAmount + 8, 2);
  });

  it("refuses to stack the minted welcome code: the order pays the better single discount", async () => {
    const bare = await quote();
    const welcome = await quote({ couponCode: "VLWELCOME-ABC234" });
    // 15% of $80 = $12, competing with the standing discount rather than
    // riding on it. Never the sum.
    expect(welcome.discountAmount).toBeCloseTo(Math.max(bare.discountAmount, 12), 2);
    expect(welcome.discountAmount).toBeLessThan(bare.discountAmount + 12);
  });

  it("refuses to stack the owner's synthetic first-order code for the same reason", async () => {
    const bare = await quote();
    const welcome = await quote({ couponCode: "WELCOME10" });
    expect(welcome.discountAmount).toBeCloseTo(Math.max(bare.discountAmount, 8), 2);
    expect(welcome.discountAmount).toBeLessThan(bare.discountAmount + 8);
  });

  it("leaves a losing welcome code off the order entirely rather than partly applied", async () => {
    const bare = await quote();
    const welcome = await quote({ couponCode: "VLWELCOME-ABC234" });
    // The standing discount is worth more than 15% here, so it wins outright
    // and the shopper pays exactly what they would have with no code typed.
    expect(bare.discountAmount).toBeGreaterThan(12);
    expect(welcome.discountAmount).toBeCloseTo(bare.discountAmount, 2);
    expect(welcome.subtotal).toBeCloseTo(bare.subtotal, 2);
    expect(welcome.shipping).toBeCloseTo(bare.shipping, 2);
  });
});
