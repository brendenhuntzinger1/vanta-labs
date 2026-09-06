import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// THE WALLET SHEET HAS TO ACCOUNT FOR EVERY DOLLAR IT TOOK OFF.
//
// quoteOrder builds `displayLineItems`, which the express lane renders VERBATIM
// into the Apple/Google Pay sheet — the shopper's last look at the price before
// they authorize it. It used to open with the bundled subtotal and then show the
// winning discount at its COMPETED value, and those are two different bases:
//
//     Subtotal            $104.97 - $4.50 of Bundle & Save  =  $100.47
//     Buy 2 Get 1 Free    $14.99 of free item - that $4.50  =   -$10.49
//
// Both figures are right and the charge was right, but between them the $4.50
// was stated on no row, so a $14.99 free item authorized as $10.49 off a
// subtotal the shopper could not reconcile with any price on the site.
//
// This file pins the property that fixes it: the rows still sum to exactly the
// merchandise the card is charged for, and Bundle & Save is one of them.
// ---------------------------------------------------------------------------

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

// The reported basket, at its reported prices: two GLP-1 at $44.99 (which earn
// the 5% two-unit tier) and one $14.99 BAC Water (which does not, and is
// therefore the cheapest unit and the one the promotion gives away).
const PRODUCTS = {
  "glp-1": { name: "GLP-1", category: "Research Peptides", price: "$44.99", stockStatus: "In Stock", image: "/a.png", description: "" },
  "bac-water": { name: "BAC Water", category: "Accessories", price: "$14.99", stockStatus: "In Stock", image: "/b.png", description: "" },
} as const;

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
}));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  // Normalised exactly as the real getHomepageControlConfig normalises it, so
  // the promotion this test switches on is the one the store ships.
  const { normalizeBxgyPromotion } = await vi.importActual<typeof import("@/lib/bxgy-config")>("@/lib/bxgy-config");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: [normalizeBxgyPromotion({ id: "buy-2-get-1-free", enabled: true })],
      bundleStacking: false,
      // Production's shipped tiers. The 5% at exactly two units is what puts
      // $4.50 inside the subtotal.
      bundleConfig: { twoUnitPercent: 0.05, threePlusPercent: 0.08, fiveUnitPercent: 0.12, tenUnitPercent: 0.2 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ ...DEFAULT_SHIPPING_CONFIG, freeShippingSitewide: true }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: false, discountPercent: 0, bundleReferralPercent: 0, personalDiscountPercent: 0, defaultCommissionPercent: 0, commissionsPaused: true }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 0, cookieWindowDays: 30, autoApprove: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: false, allowStacking: false }),
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

vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  return { ...actual, validateCoupon: async () => null };
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

async function quote() {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: [{ id: "glp-1", quantity: 2 }, { id: "bac-water", quantity: 1 }],
    customer: CUSTOMER,
    mode: "full",
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("the reported basket, priced by the real checkout", () => {
  it("charges list minus the free item — the arithmetic this change must not move", async () => {
    const quoted = await quote();
    expect(quoted.subtotal).toBe(100.47);   // $104.97 list, less $4.50 of tiers
    expect(quoted.discountAmount).toBe(10.49); // $14.99 free item, less that $4.50
    expect(quoted.subtotal - quoted.discountAmount).toBeCloseTo(89.98, 2);
  });

  it("names Bundle & Save on the wallet sheet instead of hiding it in Subtotal", async () => {
    const quoted = await quote();
    const labels = quoted.displayLineItems.map((line) => line.label);
    expect(labels).toContain("Bundle & Save");

    const subtotalRow = quoted.displayLineItems.find((line) => line.label === "Subtotal");
    expect(subtotalRow?.amountCents).toBe(10497); // full retail, matching the product pages

    const bundleRow = quoted.displayLineItems.find((line) => line.label === "Bundle & Save");
    expect(bundleRow?.amountCents).toBe(-450);
  });

  it("still sums to exactly the merchandise the card is charged for", async () => {
    // The property that must hold whatever the rows are called: a wallet sheet
    // whose lines do not add up to the charge is worse than one that omits them.
    const quoted = await quote();
    const summed = quoted.displayLineItems.reduce((total, line) => total + line.amountCents, 0);
    expect(summed).toBe(Math.round((quoted.subtotal - quoted.discountAmount) * 100));
    expect(summed).toBe(8998);
  });
});
