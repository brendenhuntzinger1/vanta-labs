import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// A GIFT OF MORE THAN ONE UNIT, AND A GIFT OF SOMETHING ALREADY IN THE CART.
//
// Until now an offer's product half was hard-coded to `quantity: 1`, so "two
// free BAC Water" was not expressible at all — the catalogue could name the
// product and nothing could name the count.
//
// The second half is the one that is easy to get wrong. A shopper who is
// promised "the BAC Water in your cart is on us" and is instead handed two MORE
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

// Real prices, so the two carts below are the two real carts.
const PRODUCTS = {
  "bac-water": { name: "BAC Water (0.9% Benzyl Alcohol)", category: "Supplies", price: "$14.99", stockStatus: "In Stock", image: "/w.png", description: "" },
  "glp-3": { name: "GLP-3", category: "Research Peptides", price: "$69.99", stockStatus: "In Stock", image: "/g.png", description: "" },
  "hgh-gh-191": { name: "HGH GH-191", category: "Research Peptides", price: "$64.99", stockStatus: "In Stock", image: "/h.png", description: "" },
} as const;

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

function promotion(id: string): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true };
}

/** A stored customer_offers row granting `quantity` free BAC Water. */
function bacWaterOffer(quantity: number | null | undefined, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "offer-1",
    offer_key: "labor_day_bac_water_2",
    email: CUSTOMER.email,
    reward_kind: "free_product",
    product_slug: "bac-water",
    percent_off: null,
    variant_id: null,
    min_subtotal_cents: 3500,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    reserved_order_id: null,
    redeemed_at: null,
    ...overrides,
  };
  // `undefined` models a row read from a database that predates the column.
  if (quantity !== undefined) row.quantity = quantity;
  return row;
}

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
  bundleState.config = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 };
});

// ---------------------------------------------------------------------------

describe("how many units a product gift grants", () => {
  it("grants the stored count when the cart holds none of it", async () => {
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 10 }], "token");

    const gifts = giftLines(quoted);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].quantity).toBe(2);
    expect(gifts[0].product.price).toBe(0);
    expect(gifts[0].baseUnitPrice).toBe(0);
    // Two vials of water arrive that the shopper did not have before.
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    // And they cost nothing: the paid subtotal is the HGH alone.
    expect(quoted.subtotal).toBe(649.9);
  });

  it("still grants exactly one for a row minted before the column existed", async () => {
    // Backwards compatibility is not cosmetic here: every live win-back token
    // was minted without a quantity, and reading a missing column as 0 would
    // silently stop shipping the free GHK-Cu those emails promised.
    offerState.offer = bacWaterOffer(undefined);

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 1 }], "token");

    expect(giftLines(quoted)).toHaveLength(1);
    expect(giftLines(quoted)[0].quantity).toBe(1);
  });

  it("treats a null quantity as one, the same as a missing one", async () => {
    offerState.offer = bacWaterOffer(null);

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 1 }], "token");

    expect(giftLines(quoted)[0].quantity).toBe(1);
  });

  it("refuses to turn a nonsense stored count into a nonsense order line", async () => {
    // Nothing should ever write these, which is exactly why the pricing path
    // must not be the thing that assumes so. A negative or fractional quantity
    // reaching order_items is a corrupt order and an un-shippable pick list.
    for (const stored of [0, -3, 2.7, Number.NaN]) {
      vi.resetModules();
      offerState.offer = bacWaterOffer(stored);
      const quoted = await quote([{ id: "hgh-gh-191", quantity: 1 }], "token");
      const gifts = giftLines(quoted);
      expect(gifts).toHaveLength(1);
      expect(Number.isInteger(gifts[0].quantity)).toBe(true);
      expect(gifts[0].quantity).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("a gift of something the cart already holds", () => {
  it("frees the units already in the basket rather than adding more", async () => {
    // Heidi's real cart: GLP-3 10mg plus two BAC Water. "Both your BAC Water
    // are on us" has to mean the two she chose, not two more.
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    // Still two vials in the box, not four.
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    // And none of them is charged for.
    expect(quoted.lineItems.filter((line) => slugOf(line) === "bac-water" && !line.gift)).toHaveLength(0);
    expect(giftLines(quoted)[0].quantity).toBe(2);
    // She pays for the GLP-3 and nothing else.
    expect(quoted.subtotal).toBe(69.99);
    expect(quoted.expectedTotal).toBe(69.99);
  });

  it("tops up the shortfall when the cart holds fewer than the gift grants", async () => {
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 1 }],
      "token",
    );

    // One absorbed, one added: two free vials in total, as promised.
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    expect(giftLines(quoted)[0].quantity).toBe(2);
    expect(quoted.lineItems.filter((line) => slugOf(line) === "bac-water" && !line.gift)).toHaveLength(0);
    expect(quoted.subtotal).toBe(69.99);
  });

  it("absorbs only what the gift covers and charges for the rest", async () => {
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 3 }],
      "token",
    );

    expect(unitsOf(quoted, "bac-water")).toBe(3);
    expect(giftLines(quoted)[0].quantity).toBe(2);
    const paid = quoted.lineItems.find((line) => slugOf(line) === "bac-water" && !line.gift);
    expect(paid?.quantity).toBe(1);
    // $69.99 + one vial at $14.99.
    expect(quoted.subtotal).toBe(84.98);
  });
});

describe("what the rest of the cart is allowed to see", () => {
  it("does not let an absorbed unit also earn a Buy X Get Y reward", async () => {
    // Without absorption Heidi's three units (GLP-3 + 2 BAC) form one Buy 2
    // Get 1 group and the engine frees her cheapest unit — a BAC Water. If the
    // absorbed units stayed eligible she would be given the same vial twice and
    // the store would book the discount for a unit it had already donated.
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    expect(quoted.subtotal).toBe(69.99);
    // One paid unit left; a Buy 2 Get 1 group needs three.
    expect(quoted.expectedTotal).toBe(69.99);
    expect(quoted.isBuy3Get1Active).toBe(false);
  });

  it("leaves an untouched cart's promotion exactly as it was", async () => {
    // Heath's cart: the gift is two vials of water he did not have, so nothing
    // is absorbed and Buy 2 Get 1 must still free three of his ten HGH.
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = bacWaterOffer(2);

    const withGift = await quote([{ id: "hgh-gh-191", quantity: 10 }], "token");
    vi.resetModules();
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = null;
    const withoutGift = await quote([{ id: "hgh-gh-191", quantity: 10 }]);

    expect(withGift.expectedTotal).toBe(withoutGift.expectedTotal);
    // Ten units, three groups of three, the three cheapest free: 7 x $64.99.
    expect(withGift.expectedTotal).toBe(454.93);
    expect(unitsOf(withGift, "bac-water")).toBe(2);
  });

  it("re-prices a shrunken line at the tier it now qualifies for", async () => {
    // A line that loses units to the gift must lose the volume price those
    // units bought. Otherwise a ten-unit order absorbed down to eight keeps the
    // 20% ten-unit rate on units nobody is buying, and the store eats it.
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    offerState.offer = bacWaterOffer(2, { product_slug: "hgh-gh-191", min_subtotal_cents: 0 });

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 10 }], "token");

    const paid = quoted.lineItems.find((line) => slugOf(line) === "hgh-gh-191" && !line.gift);
    expect(paid?.quantity).toBe(8);
    // Eight units is the five-unit tier (12%), not the ten-unit tier (20%).
    expect(paid?.product.price).toBe(57.19);
    expect(quoted.subtotal).toBe(457.52);
    expect(unitsOf(quoted, "hgh-gh-191")).toBe(10);
  });
});

describe("when the gift cannot stand", () => {
  it("gives absorbed units back as paid rather than deleting them", async () => {
    // The floor is judged a second time on what the customer will actually pay.
    // If the gift is withdrawn there, the units it had absorbed must return to
    // the order as ordinary paid lines — the shopper put them in the basket and
    // must not silently lose them along with the offer.
    //
    // THE FLOOR HAS TO SIT BETWEEN THE TWO TESTS or this proves nothing. At
    // $80: the first test sees the whole $99.97 basket and lets the gift
    // through, so the two vials really are absorbed; the second sees the
    // $69.99 that is left and withdraws it, which is the only path that
    // reaches the restore. A floor above both (the first thing tried here)
    // refuses the gift before it ever absorbs anything, and the assertions
    // below then pass against code that has no restore at all.
    offerState.offer = bacWaterOffer(2, { min_subtotal_cents: 8000 });

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    expect(giftLines(quoted)).toHaveLength(0);
    expect(quoted.appliedOffer).toBeNull();
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    const paid = quoted.lineItems.find((line) => slugOf(line) === "bac-water" && !line.gift);
    expect(paid?.quantity).toBe(2);
    expect(quoted.subtotal).toBe(99.97);
  });

  it("re-prices the restored basket instead of charging it at the shrunken one's rates", async () => {
    // Handing the units back is only half of it. Everything sized from the
    // basket was sized from the SMALLER basket: with the two vials absorbed
    // there was one paid unit and no Buy 2 Get 1 group, so the promotion was
    // worth nothing. Give the units back and there are three paid units and a
    // real reward — and a quote that charges for the restored basket while
    // pricing it with the absorbed basket's promotion bills the customer
    // $99.97 for an order that owes $84.98.
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = bacWaterOffer(2, { min_subtotal_cents: 8000 });

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    expect(giftLines(quoted)).toHaveLength(0);
    expect(quoted.subtotal).toBe(99.97);
    // Three paid units, one group, the cheapest unit free.
    expect(quoted.isBuy3Get1Active).toBe(true);
    expect(quoted.expectedTotal).toBe(84.98);
  });

  it("adds nothing and absorbs nothing when the gift product is out of stock", async () => {
    // Tracked at zero. The existing rule is that the product half simply does
    // not apply; absorption must not become a way for it to apply anyway.
    stockState.levels = new Map([["bac-water", 0]]);
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    expect(giftLines(quoted)).toHaveLength(0);
    expect(quoted.subtotal).toBe(99.97);
  });

  it("never adds more new units than the shelf can cover", async () => {
    // Two granted, one on the shelf, none in the cart: ship the one that
    // exists. Adding two would have reserve_inventory refuse the whole order
    // over a unit the shopper never asked for.
    stockState.levels = new Map([["bac-water", 1]]);
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote([{ id: "glp-3", quantity: 1 }], "token");

    expect(giftLines(quoted)[0].quantity).toBe(1);
    expect(unitsOf(quoted, "bac-water")).toBe(1);
  });

  it("counts the cart's own units against the shelf before adding", async () => {
    // One on the shelf and one already being bought means there is nothing
    // spare to add — but the one in the cart can still be made free.
    stockState.levels = new Map([["bac-water", 1]]);
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 1 }],
      "token",
    );

    expect(unitsOf(quoted, "bac-water")).toBe(1);
    expect(giftLines(quoted)[0].quantity).toBe(1);
    expect(quoted.subtotal).toBe(69.99);
  });
});

describe("the two carts this was built for", () => {
  it("prices Heath's cart at seven of ten, with two vials of water free", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    offerState.offer = bacWaterOffer(2, { email: CUSTOMER.email });

    const quoted = await quote([{ id: "hgh-gh-191", quantity: 10 }], "token");

    // Buy 2 Get 1 ($194.97 off the $649.90 list) beats the ten-unit bundle
    // tier ($130.00), so the promotion is what the customer gets.
    expect(quoted.expectedTotal).toBe(454.93);
    expect(unitsOf(quoted, "hgh-gh-191")).toBe(10);
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    expect(quoted.appliedOffer?.rewardKind).toBe("free_product");
  });

  it("prices Heidi's cart as the GLP-3 alone, both vials free", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    expect(quoted.expectedTotal).toBe(69.99);
    expect(unitsOf(quoted, "bac-water")).toBe(2);
    expect(unitsOf(quoted, "glp-3")).toBe(1);
  });

  it("still rewards Heidi for adding another peptide", async () => {
    // The point of her email. Two peptides plus the two free vials: Buy 2 Get 1
    // needs three PAID units, so a third peptide is what earns the reward — the
    // free water cannot stand in for it, in either direction.
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = bacWaterOffer(2);

    const quoted = await quote(
      [{ id: "glp-3", quantity: 1 }, { id: "hgh-gh-191", quantity: 2 }, { id: "bac-water", quantity: 2 }],
      "token",
    );

    // Three paid peptide units: one group, cheapest unit free ($64.99).
    expect(quoted.subtotal).toBe(199.97);
    expect(quoted.expectedTotal).toBe(134.98);
    expect(unitsOf(quoted, "bac-water")).toBe(2);
  });
});
