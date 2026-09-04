import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// THE FREE GIFT MUST BE INVISIBLE TO EVERY OTHER PROMOTION.
//
// quote-order.ts adds a one-time offer's free unit to lineItems as a $0 line,
// and its own comment promises that "no percentage discount, bundle tier or
// Buy X Get Y promotion can see the extra line". The Buy X Get Y engine
// expands lineItems into individual units, keeps every unit priced >= 0, and
// rewards the CHEAPEST ones — so a $0 gift unit was the first unit it picked.
//
// Two ways that goes wrong, both driven here through the real quoteOrder:
//
//   * a basket that already earned a reward loses it, because the free unit
//     absorbs the reward at $0 — the customer who was promised a free GHK-Cu
//     on top of Buy 3 Get 1 silently pays for the unit the promotion owed;
//   * a basket one unit short of a reward gets one, because the gift unit
//     completes the group — the store gives away a unit the customer never
//     bought.
// ---------------------------------------------------------------------------

const promotionState = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
}));

const offerState = vi.hoisted(() => ({
  /** The customer_offers row peekCustomerOffer would return, or null. */
  offer: null as null | {
    id: string; offer_key: string; email: string; reward_kind: string;
    product_slug: string | null; percent_off: number | null; variant_id: string | null;
    min_subtotal_cents: number; expires_at: string; reserved_order_id: string | null; redeemed_at: string | null;
  },
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    peekCustomerOffer: async (input: { token: string; email: string }) =>
      offerState.offer && offerState.offer.email === input.email.toLowerCase() ? offerState.offer : null,
  };
});

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
  const rpc = async (fn: string) => {
    if (fn === "bxgy_count_redemptions") return { data: 0, error: null };
    if (fn === "bxgy_claim_redemption") return { data: true, error: null };
    if (fn === "bxgy_release_redemption") return { data: true, error: null };
    return { data: null, error: null };
  };
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
  const client = { from: () => chain(), rpc };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "peptide-b": { name: "Peptide B", category: "Research Peptides", price: "$40.00", stockStatus: "In Stock", image: "/b.png", description: "" },
  "ghk-cu": { name: "GHK-Cu", category: "Research Peptides", price: "$47.99", stockStatus: "In Stock", image: "/g.png", description: "" },
} as const;

/** Tracked stock, keyed the way getStockLevelsBySlugs keys it. Empty = untracked. */
const stockState = vi.hoisted(() => ({ levels: new Map<string, number>() }));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map(stockState.levels),
}));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: promotionState.promotions,
      bundleStacking: false,
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 0, freeShippingThreshold: 1, internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0 }),
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
  email: "lapsed@example.test",
  fullName: "Lapsed Buyer",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

function promotion(id: string): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true };
}

function freeGhkOffer() {
  return {
    id: "offer-1",
    offer_key: "winback_60_free_ghkcu",
    email: CUSTOMER.email,
    reward_kind: "free_product",
    product_slug: "ghk-cu",
    percent_off: null,
    variant_id: null,
    min_subtotal_cents: 6000,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    reserved_order_id: null,
    redeemed_at: null,
  };
}

async function quote(items: Array<{ id: string; quantity: number }>, offerToken?: string) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({ items, customer: CUSTOMER, offerToken, mode: "full" });
}

beforeEach(() => {
  vi.resetModules();
  promotionState.promotions = [];
  offerState.offer = null;
  stockState.levels = new Map();
});

describe("a percentage-only gift", () => {
  it("takes the percentage off and charges shipping as usual", async () => {
    offerState.offer = { ...freeGhkOffer(), offer_key: "winback_60_percent_15", reward_kind: "percent", product_slug: null, percent_off: 15, min_subtotal_cents: 3500 };

    // 2 x $40 = $80: over the $35 floor. 15% of $80 is $12.
    const quoted = await quote([{ id: "peptide-b", quantity: 2 }], "token");

    expect(quoted.appliedOffer?.rewardKind).toBe("percent");
    expect(quoted.appliedOffer?.description).toBe("15% off");
    expect(quoted.discountAmount).toBe(12);
    expect(quoted.lineItems.some((line) => line.gift)).toBe(false);
    expect(quoted.expectedTotal).toBe(68);
  });

  it("gives nothing under its floor, and keeps the token", async () => {
    offerState.offer = { ...freeGhkOffer(), offer_key: "winback_60_percent_15", reward_kind: "percent", product_slug: null, percent_off: 15, min_subtotal_cents: 6000 };

    // $40 is under a $60 floor: no discount, and the offer is not "applied".
    const under = await quote([{ id: "peptide-b", quantity: 1 }], "token");
    expect(under.appliedOffer).toBeNull();
    expect(under.discountAmount).toBe(0);
    expect(under.expectedTotal).toBe(40);
  });
});

describe("a gift the store cannot ship is not added", () => {
  it("skips a tracked gift product with nothing on the shelf, and prices the rest of the order normally", async () => {
    offerState.offer = freeGhkOffer();
    // Tracked and empty. The catalogue status can lag the count (a hold
    // taken seconds ago), so the count is the authority here — and 0 used to
    // pass the old `> 0 && < 1` check, which no integer can fail.
    stockState.levels = new Map([["ghk-cu", 0], ["peptide-b", 40]]);

    const quoted = await quote([{ id: "peptide-b", quantity: 2 }], "token");

    expect(quoted.appliedOffer).toBeNull();
    expect(quoted.lineItems.some((line) => line.product.id.startsWith("ghk-cu"))).toBe(false);
    expect(quoted.expectedTotal).toBe(80);
  });

  it("adds a tracked gift that is in stock", async () => {
    offerState.offer = freeGhkOffer();
    stockState.levels = new Map([["ghk-cu", 3], ["peptide-b", 40]]);

    const quoted = await quote([{ id: "peptide-b", quantity: 2 }], "token");

    expect(quoted.appliedOffer?.rewardKind).toBe("free_product");
    expect(quoted.lineItems.find((line) => line.gift)?.product.id).toBe("ghk-cu");
  });
});

describe("a one-time gift and a Buy X Get Y promotion on the same order", () => {
  it("adds the gift as a $0 line without touching the promotion the basket earned", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    offerState.offer = freeGhkOffer();

    // 4 x $40 = $160: clears the $60 minimum AND is a complete Buy 3 Get 1
    // group, so the customer is owed one $40 unit free and one free GHK-Cu.
    const quoted = await quote([{ id: "peptide-b", quantity: 4 }], "token");

    expect(quoted.appliedOffer?.rewardKind).toBe("free_product");
    const gift = quoted.lineItems.find((line) => line.product.id.startsWith("ghk-cu"));
    expect(gift?.product.price).toBe(0);
    expect(gift?.quantity).toBe(1);

    expect(quoted.subtotal).toBe(160);
    expect(quoted.appliedPromotionId).toBe("buy-3-get-1-free");
    // The $40 unit is the free one, not the $0 gift.
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.expectedTotal).toBe(120);
  });

  it("does not let the gift complete a reward group the customer did not buy", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    offerState.offer = freeGhkOffer();

    // 3 x $40 = $120: clears the minimum, one unit short of a group.
    const quoted = await quote([{ id: "peptide-b", quantity: 3 }], "token");

    expect(quoted.appliedOffer?.rewardKind).toBe("free_product");
    expect(quoted.lineItems.some((line) => line.product.id.startsWith("ghk-cu"))).toBe(true);
    expect(quoted.appliedPromotionId).toBeNull();
    expect(quoted.discountAmount).toBe(0);
    expect(quoted.expectedTotal).toBe(120);
  });

  it("gives no gift below the minimum, and the promotion is unaffected", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    offerState.offer = freeGhkOffer();

    // $40: under the $60 floor. No gift line, but Buy 1 Get 1 is untouched.
    const quoted = await quote([{ id: "peptide-b", quantity: 1 }], "token");
    expect(quoted.appliedOffer).toBeNull();
    expect(quoted.lineItems.some((line) => line.product.id.startsWith("ghk-cu"))).toBe(false);
    expect(quoted.discountAmount).toBe(0);
  });
});
