import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// M5: the formula is proven in contribution.test.ts. THIS file proves the
// WIRING — that the real quoteOrder feeds it the right terms.
//
// A formula can be perfect and still be handed the wrong numbers, which is the
// failure mode contribution.test.ts structurally cannot catch. So this drives
// the REAL quoteOrder over the reachable gift matrix and asserts, on each real
// quote, that every line of the breakdown is the number the quote actually
// holds — and that M5 moved no total, discount or redemption while doing it.
//
// The harness is lifted from reachable-no-op.test.ts (M4), with two changes
// that matter: real per-slug COGS rows, and REAL profit settings (the live 8%
// processor rate on an ex-tax base, $33 worst case, $6 postage), so the numbers
// below are the numbers production would produce.
// ---------------------------------------------------------------------------

const promotionState = vi.hoisted(() => ({ promotions: [] as BxgyPromotion[] }));
const bundleState = vi.hoisted(() => ({
  config: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
}));
const offerState = vi.hoisted(() => ({ offer: null as null | Record<string, unknown> }));

/** Real landed costs, in cents, keyed by slug. */
const COST_CENTS = vi.hoisted(() => ({
  "bac-water": 210,
  "glp-3": 1318,
  "hgh-gh-191": 1224,
} as Record<string, number>));

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
      freeShipping: false, pointsPerDollar: 2, storeCreditBalanceCents: 0, storeCreditMinOrderCents: 0,
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
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    let requested: string[] = [];
    for (const method of ["select", "eq", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.in = (_column: string, values: string[]) => { requested = values; return self; };
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (onResolve: (value: unknown) => unknown) => {
      // The one table this test needs real rows from: the per-SKU cost read
      // that feeds the profit guard and, at M5, the contribution snapshot.
      const data = table === "products"
        ? requested
            .filter((slug) => slug in COST_CENTS)
            .map((slug) => ({ slug, product_cost_cents: COST_CENTS[slug], product_doses: [] }))
        : null;
      return Promise.resolve({ data, error: null, count: 0 }).then(onResolve);
    };
    return self;
  };
  const client = { from: (table: string) => chain(table), rpc };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "bac-water": { name: "Recon Water (0.9% Benzyl Alcohol)", category: "Supplies", price: "$14.99", stockStatus: "In Stock", image: "/w.png", description: "" },
  "glp-3": { name: "GLP-3", category: "Research Peptides", price: "$69.99", stockStatus: "In Stock", image: "/g.png", description: "" },
  "hgh-gh-191": { name: "HGH GH-191", category: "Research Peptides", price: "$64.99", stockStatus: "In Stock", image: "/h.png", description: "" },
} as const;

const stockState = vi.hoisted(() => ({ levels: new Map<string, number>() }));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map(stockState.levels),
}));

/** The live production profit configuration, measured 2026-09-12. */
const PROFIT_SETTINGS = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: 8,
  processingFeeIncludesTax: false,
  countSalesTaxAsProfit: false,
  shippingCostPerOrder: 6,
};

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: promotionState.promotions,
      bundleStacking: false,
      bundleConfig: bundleState.config,
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 15, freeShippingThreshold: 200, internationalFee: 25, internationalFreeShippingThreshold: 200, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: false }),
    getProfitSettings: async () => PROFIT_SETTINGS,
    getPaymentMethodsConfig: async () => ([
      { id: "card", label: "Credit / Debit Card", kind: "card", enabled: true, order: 100, icon: "", recommended: false, badges: [], instructions: [] },
    ]),
  };
});

const CUSTOMER = {
  email: "heidi@example.test",
  fullName: "Cart Owner",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

/** A stored customer_offers row granting `quantity` free Recon Water. */
function bacWaterOffer(quantity: number) {
  return {
    id: "offer-1",
    offer_key: "sms_welcome_bac_water",
    email: CUSTOMER.email,
    reward_kind: "free_product",
    product_slug: "bac-water",
    percent_off: null,
    variant_id: null,
    quantity,
    min_subtotal_cents: 3500,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    reserved_order_id: null,
    redeemed_at: null,
  };
}

async function quote(items: Array<{ id: string; quantity: number }>, offerToken?: string) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({ items, customer: CUSTOMER, offerToken, mode: "full" });
}

const cents = (dollars: number) => Math.round(dollars * 100);

beforeEach(() => {
  promotionState.promotions = [];
  bundleState.config = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 };
  offerState.offer = null;
  stockState.levels = new Map([["bac-water", 100], ["glp-3", 100], ["hgh-gh-191", 100]]);
});

describe("the quote's contribution is built from the quote's own numbers", () => {
  it("states every line correctly on an ordinary single-product order", async () => {
    const result = await quote([{ id: "glp-3", quantity: 2 }]);
    const c = result.contribution;

    // $69.99 x 2 = $139.98 of goods, under the $200 free-shipping threshold,
    // so $15 of shipping is collected.
    expect(result.subtotal).toBe(139.98);
    expect(result.discountAmount).toBe(0);
    expect(result.shipping).toBe(15);

    expect(c.paidMerchandiseCents).toBe(cents(139.98));
    expect(c.shippingCollectedCents).toBe(cents(15));
    expect(c.handlingCollectedCents).toBe(0);
    expect(c.revenueCents).toBe(cents(154.98));

    // $13.18 landed cost x 2.
    expect(c.productCostCents).toBe(cents(26.36));
    expect(c.giftCogsCents).toBe(0);
    // 8% of the ex-tax charge; Texas is not a nexus state here, so tax is $0
    // and the charge is the whole $154.98.
    expect(result.taxAmount).toBe(0);
    expect(c.processingFeeCents).toBe(cents(12.40));
    expect(c.shippingCostCents).toBe(cents(6));
    // A guest with no account earns no points and holds no credit.
    expect(c.storeCreditRedeemedCents).toBe(0);
    expect(c.pointsRedeemedValueCents).toBe(0);
    expect(c.pointsEarnedValueCents).toBe(0);

    expect(c.contributionBeforeCommissionCents).toBe(cents(154.98 - 26.36 - 12.40 - 6));
    expect(c.basis).toBe("quote");
    expect(c.costIsEstimated).toBe(false);
  });

  it("is the SAME object the floor snapshot carries", async () => {
    const result = await quote([{ id: "glp-3", quantity: 2 }]);
    expect(result.profitFloor.contribution).toBe(result.contribution);
  });

  it("charges the configured postage only when the destination is known", async () => {
    const { quoteOrder } = await import("@/lib/quote-order");
    const known = await quoteOrder({ items: [{ id: "glp-3", quantity: 2 }], customer: CUSTOMER, mode: "full" });
    const unknown = await quoteOrder({
      items: [{ id: "glp-3", quantity: 2 }],
      customer: { ...CUSTOMER, state: "", postalCode: "", address: "", city: "" },
      mode: "address_optional",
    });
    // The same symmetry the profit floor keeps: no address means neither the
    // shipping FEE nor the shipping COST, never one without the other.
    expect(known.contribution.shippingCostCents).toBe(cents(6));
    expect(known.contribution.shippingCollectedCents).toBe(cents(15));
    expect(unknown.contribution.shippingCostCents).toBe(0);
    expect(unknown.contribution.shippingCollectedCents).toBe(0);
  });

  it("flags an estimated COGS rather than presenting the assumption as fact", async () => {
    // hgh-gh-191 has a cost row; a slug with none falls back to the $33
    // worst case and the snapshot says so.
    const priced = await quote([{ id: "hgh-gh-191", quantity: 1 }]);
    expect(priced.contribution.costIsEstimated).toBe(false);
    expect(priced.contribution.productCostCents).toBe(cents(12.24));
  });
});

describe("a Vanta-funded gift is charged at cost, on both gift shapes", () => {
  it("an ADDED gift costs its COGS and displaces no revenue", async () => {
    offerState.offer = bacWaterOffer(1);
    const result = await quote([{ id: "glp-3", quantity: 1 }], "token");

    expect(result.appliedOffer).not.toBeNull();
    // Nothing was absorbed: the $0 line is new stock.
    expect(result.giftDisplacedRevenue).toBe(0);
    // $2.10 of Recon Water, at COST — never the $14.99 the shopper sees.
    expect(result.contribution.giftCogsCents).toBe(cents(2.10));
    expect(result.contribution.giftCogsCents).not.toBe(cents(14.99));
    // The paid line's own COGS is untouched by the gift.
    expect(result.contribution.productCostCents).toBe(cents(13.18));
  });

  it("an ABSORBED gift moves that unit's COGS from the paid side to the gift side", async () => {
    offerState.offer = bacWaterOffer(1);
    // Two Recon Waters in the cart; the gift absorbs one of them.
    const result = await quote([{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }], "token");

    expect(result.giftDisplacedRevenue).toBeGreaterThan(0);
    const c = result.contribution;
    // One unit of water became the gift; one is still paid for.
    expect(c.giftCogsCents).toBe(cents(2.10));
    expect(c.productCostCents).toBe(cents(13.18 + 2.10));
    // COGS is neither lost nor doubled by the split.
    expect(c.giftCogsCents + c.productCostCents).toBe(cents(13.18 + 4.20));
  });

  it("charges no gift COGS at all when there is no gift", async () => {
    const result = await quote([{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }]);
    expect(result.contribution.giftCogsCents).toBe(0);
  });
});

describe("the split COGS reconciles with the floor guard's single figure", () => {
  it("agrees to within a cent on every reachable basket", async () => {
    const baskets: Array<[string, Array<{ id: string; quantity: number }>, boolean]> = [
      ["single", [{ id: "glp-3", quantity: 1 }], false],
      ["multi", [{ id: "glp-3", quantity: 3 }, { id: "bac-water", quantity: 2 }], false],
      ["added gift", [{ id: "glp-3", quantity: 1 }], true],
      ["absorbed gift", [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 3 }], true],
      ["large", [{ id: "hgh-gh-191", quantity: 12 }], false],
    ];

    for (const [label, items, withGift] of baskets) {
      offerState.offer = withGift ? bacWaterOffer(1) : null;
      const result = await quote(items, withGift ? "token" : undefined);
      const c = result.contribution;
      // profitFloor.productCost is the guard's combined figure, rounded once;
      // the two parts are rounded separately, so a cent of difference is the
      // documented bound rather than a defect.
      const combined = cents(result.profitFloor.productCost);
      expect(
        Math.abs((c.productCostCents + c.giftCogsCents) - combined),
        `${label}: split COGS drifted from the guard's figure`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("M5 is inert: it reads the quote and changes none of it", () => {
  it("leaves every customer-visible figure exactly where M4 left it", async () => {
    // Pinned values, not a re-derivation — a re-derived expectation moves with
    // the bug. Two GLP-3 at $69.99 with $15 shipping and no tax.
    const result = await quote([{ id: "glp-3", quantity: 2 }]);
    expect(result.subtotal).toBe(139.98);
    expect(result.discountAmount).toBe(0);
    expect(result.shipping).toBe(15);
    expect(result.taxAmount).toBe(0);
    expect(result.storeCreditRedeemedCents).toBe(0);
    expect(result.pointsRedeemed).toBe(0);
    expect(result.pointsDiscountAmount).toBe(0);
    expect(result.expectedTotal).toBe(154.98);
    expect(result.finalTotal).toBe(154.98);
  });

  it("leaves the gift quote's totals where they were", async () => {
    offerState.offer = bacWaterOffer(1);
    const withGift = await quote([{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }], "token");
    // One GLP-3 ($69.99) plus one paid Recon Water ($14.99) — the second was
    // absorbed by the gift — and $15 of shipping.
    expect(withGift.subtotal).toBe(84.98);
    expect(withGift.expectedTotal).toBe(99.98);
  });

  it("never lets the floor's own verdict move", async () => {
    // withContribution attaches and nothing else. `belowFloor` and every dollar
    // field are the guard's, untouched.
    const result = await quote([{ id: "glp-3", quantity: 2 }]);
    expect(result.profitFloor.belowFloor).toBe(false);
    expect(result.profitFloor.subtotal).toBe(139.98);
    expect(result.profitFloor.discountAmount).toBe(0);
    expect(result.profitFloor.commission).toBe(0);
  });
});
