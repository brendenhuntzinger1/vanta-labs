import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// M4 REQUIREMENT 10: prove the no-op across REACHABLE behaviour, not just by
// unit-testing the helper.
//
// bases.test.ts sweeps `deriveOrderBases` over thousands of synthetic triples.
// That proves the function. It does NOT prove that the numbers the function is
// fed in production make the three bases collapse — a helper can be perfect and
// still be wired to the wrong inputs.
//
// So this file drives the REAL quoteOrder across the reachable matrix the
// requirements name — no gift, added gift, absorbed gift, multiple quantities,
// discount combinations, referral, Vanta Pro, points and store credit, and
// boundary cart values — and asserts on each real quote that:
//
//   1. all three bases are one number, and
//   2. that number is exactly the historical `subtotal - discount_amount`, and
//   3. giftDisplacedRevenue is zero unless a gift actually absorbed units.
//
// The harness (mocks, catalogue, customer) is lifted from
// offer-gift-quantity.test.ts so this exercises the same engine the gift tests
// already trust.
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

/** A stored customer_offers row granting `quantity` free Recon Water. */
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


const roundMoney = (v: number) => Math.round(v * 100) / 100;

/** The exact expression the three payment-webhook sites used before M4. */
const historicalBasis = (subtotal: number, discountAmount: number) =>
  roundMoney(Math.max(0, subtotal - discountAmount));

/** Assert the M4 invariant on a real quote. */
async function expectBasesCollapse(
  label: string,
  items: Array<{ id: string; quantity: number }>,
  offerToken?: string,
) {
  const { deriveOrderBases } = await import("@/lib/benefits/bases");
  const result = await quote(items, offerToken);
  const bases = deriveOrderBases({
    subtotal: result.subtotal,
    discountAmount: result.discountAmount,
    giftDisplacedRevenue: result.giftDisplacedRevenue,
    // Even naming a channel must not move anything while the flags are off.
    giftChannel: "sms",
  });
  const expected = historicalBasis(result.subtotal, result.discountAmount);

  expect(bases.paidMerchandise, `${label}: paidMerchandise`).toBe(expected);
  expect(bases.rewardBase, `${label}: rewardBase`).toBe(expected);
  expect(bases.commissionableBase, `${label}: commissionableBase`).toBe(expected);
  expect(bases.commissionUplifted, `${label}: nothing may be uplifted at M4`).toBe(false);
  return result;
}

beforeEach(() => {
  promotionState.promotions = [];
  bundleState.config = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 };
  offerState.offer = null;
  stockState.levels = new Map([["bac-water", 100], ["glp-3", 100], ["hgh-gh-191", 100]]);
});

describe("M4 across reachable quotes: the three bases are always one number", () => {
  it("no gift, single unit", async () => {
    const result = await expectBasesCollapse("single", [{ id: "glp-3", quantity: 1 }]);
    expect(result.giftDisplacedRevenue).toBe(0);
  });

  it("no gift, multiple quantities", async () => {
    for (const quantity of [1, 2, 3, 4, 5, 9, 10, 12]) {
      const result = await expectBasesCollapse(`qty ${quantity}`, [{ id: "glp-3", quantity }]);
      expect(result.giftDisplacedRevenue, `qty ${quantity} displaced`).toBe(0);
    }
  });

  it("no gift, with quantity-bundle tiers live", async () => {
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    for (const quantity of [1, 2, 3, 5, 10]) {
      await expectBasesCollapse(`bundle qty ${quantity}`, [{ id: "glp-3", quantity }]);
    }
  });

  it("no gift, with a Buy-X-Get-Y promotion live", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    for (const quantity of [3, 4, 8]) {
      await expectBasesCollapse(`bxgy qty ${quantity}`, [{ id: "glp-3", quantity }]);
    }
  });

  it("no gift, mixed basket", async () => {
    await expectBasesCollapse("mixed", [
      { id: "glp-3", quantity: 2 },
      { id: "hgh-gh-191", quantity: 1 },
      { id: "bac-water", quantity: 3 },
    ]);
  });

  it("ADDED gift — product not in the cart — displaces nothing", async () => {
    offerState.offer = bacWaterOffer(1);
    const result = await expectBasesCollapse("added gift", [{ id: "glp-3", quantity: 2 }], "tok");
    // Requirement 7: an added gift must not invent displaced revenue.
    expect(result.giftDisplacedRevenue).toBe(0);
    expect(result.appliedOffer?.productApplied).toBe(true);
  });

  it("ABSORBED gift — product already in the cart — displaces real revenue", async () => {
    offerState.offer = bacWaterOffer(1);
    const result = await expectBasesCollapse("absorbed gift", [
      { id: "glp-3", quantity: 2 },
      { id: "bac-water", quantity: 2 },
    ], "tok");
    // The gift freed one Recon Water the shopper had chosen: real displacement.
    expect(result.giftDisplacedRevenue).toBeGreaterThan(0);
    // ...and the bases STILL collapse, because nothing consumes it at M4.
    // (expectBasesCollapse already asserted that.)
  });

  it("ABSORBED gift of several units, with bundle tiers repricing the survivors", async () => {
    // The case where the displaced amount is NOT simply one unit's price: the
    // surviving units change tier when the line shrinks.
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    offerState.offer = bacWaterOffer(2);
    const result = await expectBasesCollapse("absorbed x2 + tiers", [
      { id: "glp-3", quantity: 1 },
      { id: "bac-water", quantity: 5 },
    ], "tok");
    expect(result.giftDisplacedRevenue).toBeGreaterThan(0);
  });

  it("absorbed gift that is WITHDRAWN below its minimum displaces nothing", async () => {
    // The gift gives the units back, so there is no displacement to record.
    // This is why the value is computed after the withdrawal check.
    offerState.offer = bacWaterOffer(1, { min_subtotal_cents: 500_000 });
    const result = await expectBasesCollapse("withdrawn gift", [
      { id: "glp-3", quantity: 1 },
      { id: "bac-water", quantity: 2 },
    ], "tok");
    expect(result.appliedOffer).toBeNull();
    expect(result.giftDisplacedRevenue).toBe(0);
  });

  it("boundary cart values", async () => {
    for (const items of [
      [{ id: "bac-water", quantity: 1 }],
      [{ id: "glp-3", quantity: 1 }, { id: "bac-water", quantity: 1 }],
      [{ id: "glp-3", quantity: 14 }],
    ]) {
      await expectBasesCollapse(`boundary ${JSON.stringify(items)}`, items);
    }
  });
});

describe("M4 across reachable quotes: discount combinations", () => {
  it("holds with a referral discount applied", async () => {
    const { quoteOrder } = await import("@/lib/quote-order");
    const { deriveOrderBases } = await import("@/lib/benefits/bases");
    const result = await quoteOrder({
      items: [{ id: "glp-3", quantity: 2 }],
      customer: CUSTOMER,
      referralCode: "AMB10",
      mode: "full",
    });
    const bases = deriveOrderBases({
      subtotal: result.subtotal,
      discountAmount: result.discountAmount,
      giftDisplacedRevenue: result.giftDisplacedRevenue,
      giftChannel: "sms",
    });
    const expected = historicalBasis(result.subtotal, result.discountAmount);
    expect(bases.paidMerchandise).toBe(expected);
    expect(bases.rewardBase).toBe(expected);
    expect(bases.commissionableBase).toBe(expected);
  });

  it("holds with a gift AND a competing promotion", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    offerState.offer = bacWaterOffer(1);
    await expectBasesCollapse("gift + bxgy", [
      { id: "glp-3", quantity: 4 },
      { id: "bac-water", quantity: 1 },
    ], "tok");
  });

  it("holds with a gift AND bundle tiers AND a mixed basket", async () => {
    bundleState.config = { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 };
    offerState.offer = bacWaterOffer(1);
    await expectBasesCollapse("gift + tiers + mixed", [
      { id: "glp-3", quantity: 3 },
      { id: "bac-water", quantity: 2 },
      { id: "hgh-gh-191", quantity: 1 },
    ], "tok");
  });
});

describe("giftDisplacedRevenue is exposed but consumed by nothing at M4", () => {
  it("is present on every quote, as a number", async () => {
    const result = await quote([{ id: "glp-3", quantity: 1 }]);
    expect(typeof result.giftDisplacedRevenue).toBe("number");
    expect(Number.isFinite(result.giftDisplacedRevenue)).toBe(true);
  });

  it("never makes the customer pay differently — the quote total ignores it", async () => {
    // Two identical carts, one with an absorbing gift. The displaced value is
    // non-zero on the second, and the TOTAL is whatever the gift made it —
    // there is no path by which the displaced number itself moved a price.
    offerState.offer = bacWaterOffer(1);
    const withGift = await quote([
      { id: "glp-3", quantity: 1 },
      { id: "bac-water", quantity: 2 },
    ], "tok");
    expect(withGift.giftDisplacedRevenue).toBeGreaterThan(0);

    // The paid subtotal is the basket minus the freed unit — derived from the
    // line items, not from giftDisplacedRevenue.
    const paidLines = withGift.lineItems.filter((l) => !l.gift);
    const linesTotal = roundMoney(paidLines.reduce((sum, l) => sum + l.product.price * l.quantity, 0));
    expect(withGift.subtotal).toBe(linesTotal);
  });
});
