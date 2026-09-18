import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// A GIFT OF MORE THAN ONE UNIT, AND A GIFT OF SOMETHING ALREADY IN THE CART.
//
// Until now an offer's product half was hard-coded to `quantity: 1`, so "two
// free Recon Water" was not expressible at all — the catalogue could name the
// product and nothing could name the count.
//
// The second half is the one that is easy to get wrong. A shopper who is
// promised "the Recon Water in your cart is on us" and is instead handed two MORE
// vials has been given the wrong thing: they wanted their basket cheaper, not
// four bottles of water. So a product gift is satisfied from what the cart
// already holds FIRST, and only the shortfall is added as new stock:
//
//   cart has none    -> add all of them          (Heath: 10 vials + 2 free BAC)
//   cart has some    -> free those, add the rest
//   cart has enough  -> free those, add nothing  (Heidi: her own two, at $0)
//
// Absorbed units leave the paid subtotal, which means they also leave Buy X Get
// Y eligibility — a unit the store has already given away must not also earn a
// promotion reward. And a line that shrinks is re-priced at the quantity tier
// it now actually qualifies for, or the store would keep charging a ten-unit
// price for the eight units still being bought.
// ---------------------------------------------------------------------------

const promotionState = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
}));

const bundleState = vi.hoisted(() => ({
  config: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
}));

const offerState = vi.hoisted(() => ({
  offer: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    peekCustomerOffer: async (input: { token: string; email: string }) =>
      offerState.offer && offerState.offer.email === input.email.toLowerCase() ? offerState.offer : null,
  };
});

vi.mock("@/lib/rewards", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/rewards");
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

// Real prices, so the two carts below are the two real carts.
const PRODUCTS = {
  "bac-water": { name: "Recon Water (0.9% Benzyl Alcohol)", category: "Supplies", price: "$14.99", stockStatus: "In Stock", image: "/w.png", description: "" },
  "glp-3": { name: "GLP-3", category: "Research Peptides", price: "$69.99", stockStatus: "In Stock", image: "/g.png", description: "" },
  "hgh-gh-191": { name: "HGH GH-191", category: "Research Peptides", price: "$64.99", stockStatus: "In Stock", image: "/h.png", description: "" },
} as const;

const stockState = vi.hoisted(() => ({ levels: new Map<string, number>() }));

/**
 * GLP-3's four real strengths, and a switch for retiring one.
 *
 * getCatalogProducts filters on is_enabled, so a retired strength simply is not
 * in `doses` — which is precisely the state that used to make the gift path
 * fall through to the parent slug.
 */
const doseState = vi.hoisted(() => ({ disabled: new Set<string>() }));

const GLP3_DOSES = [
  { id: "dose-5mg", label: "5mg", sku: "GLP3-5", price: "$49.99", salePrice: null, isDefault: true, stockStatus: "In Stock" },
  { id: "dose-10mg", label: "10mg", sku: "GLP3-10", price: "$69.99", salePrice: null, isDefault: false, stockStatus: "In Stock" },
  { id: "dose-20mg", label: "20mg", sku: "GLP3-20", price: "$119.99", salePrice: null, isDefault: false, stockStatus: "In Stock" },
  { id: "dose-30mg", label: "30mg", sku: "GLP3-30", price: "$169.99", salePrice: null, isDefault: false, stockStatus: "In Stock" },
];

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({
      ...PRODUCTS[slug as keyof typeof PRODUCTS],
      slug,
      ...(slug === "glp-3"
        ? { doses: GLP3_DOSES.filter((dose) => !doseState.disabled.has(dose.id)) }
        : {}),
    })),
  getStockLevelsBySlugs: async () => new Map(stockState.levels),
}));

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
  email: "heidi@example.test",
  fullName: "Cart Owner",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

async function quote(items: Array<{ id: string; quantity: number }>, offerToken?: string) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({ items, customer: CUSTOMER, offerToken, mode: "full" });
}

/**
 * Which product a line is for, the way the rest of the system decides it.
 *
 * `product.slug` is NOT reliable here: quoteOrder builds a paid line's product
 * from productsById, which carries only id/name/price/stockStatus, while a gift
 * line spreads the whole catalogue record and does carry a slug. The line id is
 * the field both always have, and it is what parseOrderItemRef splits to decide
 * which inventory row an order item moves.
 */
function slugOf(line: { product: { id: string } }) {
  return String(line.product.id).split("::")[0];
}

/** Every unit of `slug` the order ships, gift and paid alike. */
function unitsOf(quoted: { lineItems: Array<{ product: { id: string }; quantity: number }> }, slug: string) {
  return quoted.lineItems
    .filter((line) => slugOf(line) === slug)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function giftLines<T extends { gift?: true }>(quoted: { lineItems: T[] }) {
  return quoted.lineItems.filter((line) => line.gift);
}

beforeEach(() => {
  vi.resetModules();
  promotionState.promotions = [];
  offerState.offer = null;
  stockState.levels = new Map();
  doseState.disabled = new Set();
  bundleState.config = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 };
});

/** A wheel prize granting one free GLP-3 at a chosen dose. */
function glp3Prize(variantId: string | null, minSubtotalCents: number) {
  return {
    id: "offer-spin",
    offer_key: "spin:winback_2026q4",
    email: CUSTOMER.email,
    reward_kind: "free_product",
    product_slug: "glp-3",
    percent_off: null,
    variant_id: variantId,
    quantity: 1,
    min_subtotal_cents: minSubtotalCents,
    expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    reserved_order_id: null,
    redeemed_at: null,
  };
}

describe("a wheel prize taken at a chosen dose", () => {
  it("grants the exact dose the customer picked, not the catalogue default", async () => {
    offerState.offer = glp3Prize("dose-30mg", 19_500);
    // 4 x $64.99 = $259.96, clear of the 30mg rung's $195. (Three would be
    // $194.97 — a penny short, which is the boundary the tests below pin.)
    const quoted = await quote([{ id: "hgh-gh-191", quantity: 4 }], "tok");

    const gift = giftLines(quoted).find((line) => slugOf(line) === "glp-3");
    expect(gift, "the prize should be on the order").toBeTruthy();
    expect(String(gift!.product.id)).toBe("glp-3::dose-30mg");
  });

  it("still grants the default dose for a prize minted before anyone chose", async () => {
    // variant_id null is how every spin row is minted, and how every row
    // created before this feature looks. It must keep resolving.
    offerState.offer = glp3Prize(null, 10_000);
    const quoted = await quote([{ id: "hgh-gh-191", quantity: 2 }], "tok");

    const gift = giftLines(quoted).find((line) => slugOf(line) === "glp-3");
    expect(String(gift!.product.id)).toBe("glp-3::dose-5mg");
  });

  it("WITHHOLDS the prize when the chosen dose has been retired — never substitutes another", async () => {
    // The customer chose 30mg and cleared a $195 minimum for it. Shipping them
    // the 5mg instead would be the wrong goods at the right price; falling
    // through to the bare slug would put an unbounded, dose-less line on the
    // order. Withholding is the only honest outcome.
    offerState.offer = glp3Prize("dose-30mg", 19_500);
    doseState.disabled = new Set(["dose-30mg"]);

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 4 }], "tok");

    expect(giftLines(quoted).some((line) => slugOf(line) === "glp-3"), "no substituted dose").toBe(false);
    expect(unitsOf(quoted, "glp-3"), "and no bare-slug line either").toBe(0);
  });

  it("never emits a dose-less GLP-3 line when the dose is gone", async () => {
    // The specific regression: offerDose undefined used to fall through to the
    // parent row, whose stock is untracked, so the ceiling became Infinity and
    // order_items recorded a product id with no dose.
    offerState.offer = glp3Prize("dose-20mg", 15_500);
    doseState.disabled = new Set(["dose-20mg"]);

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 4 }], "tok");
    for (const line of quoted.lineItems) {
      if (slugOf(line) !== "glp-3") continue;
      expect(String(line.product.id), "a GLP-3 line must always name its dose").toContain("::");
    }
  });
});

describe("the minimum that actually gates a chosen dose", () => {
  it("enforces the ROW's minimum, which is the rung the customer picked", async () => {
    // One cent under the 30mg rung's $195. The entry rung is $100 and the
    // table's scalar says $100 too — if either were consulted this would pass.
    offerState.offer = glp3Prize("dose-30mg", 19_500);
    const quoted = await quote([{ id: "hgh-gh-191", quantity: 2 }], "tok"); // $129.98

    expect(giftLines(quoted).some((line) => slugOf(line) === "glp-3"), "under the rung: withheld").toBe(false);
  });

  it("grants it at exactly the rung, to the cent", async () => {
    offerState.offer = glp3Prize("dose-10mg", 12_998);
    const quoted = await quote([{ id: "hgh-gh-191", quantity: 2 }], "tok"); // exactly $129.98

    const gift = giftLines(quoted).find((line) => slugOf(line) === "glp-3");
    expect(gift, "exactly the minimum must qualify").toBeTruthy();
    expect(String(gift!.product.id)).toBe("glp-3::dose-10mg");
  });

  it("refuses one cent under the rung", async () => {
    offerState.offer = glp3Prize("dose-10mg", 12_999);
    const quoted = await quote([{ id: "hgh-gh-191", quantity: 2 }], "tok"); // $129.98

    expect(giftLines(quoted).some((line) => slugOf(line) === "glp-3")).toBe(false);
  });
});
