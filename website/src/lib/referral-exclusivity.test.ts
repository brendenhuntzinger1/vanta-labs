import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT A REFERRAL CODE IS ALLOWED TO COST THE SHOPPER.
//
// Store credit and points never stack with a referral DISCOUNT. That rule is
// correct and is not in question here. What is in question is the test for it,
// which has now been wrong twice:
//
//   1. `!referral` — "a code is attached". Safe only while quoteOrder THREW on
//      a below-minimum referral, because the inert case could not reach the
//      line. Removing the throw made it reachable and the client and server
//      stopped agreeing: she watched $50 of her own credit come off the
//      displayed total and create-session refused the order.
//
//   2. `!referralQualifiesForDiscount` — "the basket is big enough". Half the
//      question. The referral still has to WIN against every other candidate in
//      resolveCustomerDiscount, and it loses to Buy-3-Get-1, to quantity-bundle
//      pricing, to membership, to bulk savings. A five-vial basket clears the
//      $100 minimum while the bundle pricing already inside its subtotal has
//      competed the ambassador's discount down to exactly $0.00 — and the
//      shopper paid her whole store-credit balance for it.
//
// An adversarial review found (2) by mutation: reverting the store-credit line
// on its own left all 4,147 tests green. Nothing anywhere passed a referral
// code into quoteOrder alongside a store-credit balance. These do.
//
// They drive the REAL quoteOrder. Nothing here restates the arithmetic.
// ---------------------------------------------------------------------------

const member = vi.hoisted(() => ({
  storeCreditBalanceCents: 0,
  storeCreditMinOrderCents: 0,
  pointsBalance: 0,
  memberDiscountPercent: 0,
}));

const ambassador = vi.hoisted(() => ({
  id: "amb-referral-exclusivity",
  name: "Xavier Martinez",
  email: "xavier@ambassadors.test",
  auth_user_id: null as string | null,
  referral_code: "VANTA15",
  commission_percent: 10,
  customer_discount_percent: 15 as number | null,
  status: "approved",
}));

vi.mock("@/lib/membership", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/membership");
  return {
    ...actual,
    getMembershipPerks: async () => ({
      isActiveMember: true,
      tierSlug: "pro",
      memberDiscountPercent: member.memberDiscountPercent,
      freeShipping: false,
      pointsPerDollar: 1,
      storeCreditBalanceCents: member.storeCreditBalanceCents,
      storeCreditMinOrderCents: member.storeCreditMinOrderCents,
    }),
    getPointsBalance: async () => member.pointsBalance,
    isEligibleForBulkSavings: async () => false,
    isPriorityMember: async () => false,
  };
});

// The only row quoteOrder needs from the database that the mocks below do not
// already supply: the ambassador behind the code. Everything else it asks for
// (per-dose unit costs) legitimately comes back empty.
vi.mock("@/lib/supabase-server", () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq"]) {
      self[method] = () => self;
    }
    self.maybeSingle = async () => result;
    self.single = async () => result;
    self.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return self;
  };
  const client = {
    from: (table: string) => (table === "ambassadors"
      ? chain({ data: { ...ambassador }, error: null })
      : chain({ data: null, error: null })),
  };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "peptide-a": { name: "Peptide A", category: "Research Peptides", price: "$60.00", stockStatus: "In Stock", image: "/x.png", description: "" },
} as const;

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
}));

const control = vi.hoisted(() => ({ buy3Get1: false }));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({ promoBuy3Get1Enabled: control.buy3Get1 }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 15, freeShippingThreshold: 1000, internationalFee: 60, internationalFreeShippingThreshold: 600, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 100, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
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
  email: "member@example.test",
  fullName: "Member Buyer",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

async function quote(input: {
  quantity: number;
  withCode?: boolean;
  storeCreditCents?: number;
  points?: number;
  memberDiscountPercent?: number;
}) {
  member.storeCreditBalanceCents = input.storeCreditCents ?? 0;
  member.storeCreditMinOrderCents = 0;
  member.pointsBalance = input.points ?? 0;
  member.memberDiscountPercent = input.memberDiscountPercent ?? 0;

  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: [{ id: "peptide-a", quantity: input.quantity }],
    customer: CUSTOMER,
    referralCode: input.withCode === false ? undefined : ambassador.referral_code,
    customerUserId: "user-member-0001",
    pointsToRedeem: input.points,
    mode: "full",
  });
}

beforeEach(() => {
  ambassador.customer_discount_percent = 15;
  ambassador.status = "approved";
  control.buy3Get1 = false;
  vi.clearAllMocks();
});

describe("a referral discount that IS given is exclusive, as it always was", () => {
  it("suppresses store credit on a qualifying basket the referral wins", async () => {
    // 3 x $60.00, 8% quantity-bundle -> $165.60 subtotal, over the $100 minimum.
    // 15% of the $180.00 list beats the $14.40 already granted, so the referral
    // is the winning discount.
    const quoted = await quote({ quantity: 3, storeCreditCents: 5000 });

    expect(quoted.discountAmount).toBeGreaterThan(0);
    expect(quoted.storeCreditRedeemedCents).toBe(0);
  });

  it("suppresses points on a qualifying basket the referral wins", async () => {
    const quoted = await quote({ quantity: 3, points: 500 });

    expect(quoted.discountAmount).toBeGreaterThan(0);
    expect(quoted.pointsRedeemed).toBe(0);
    expect(quoted.pointsDiscountAmount).toBe(0);
  });
});

describe("a referral that gives nothing costs the shopper nothing", () => {
  it("redeems store credit below the minimum qualifying order", async () => {
    // One vial, $60.00 — under the $100 minimum, so no referral discount.
    const quoted = await quote({ quantity: 1, storeCreditCents: 5000 });

    expect(quoted.discountAmount).toBe(0);
    expect(quoted.storeCreditRedeemedCents).toBe(5000);
    // And the code is still on the order, so the ambassador keeps the credit
    // for sending the customer.
    expect(quoted.referral?.code).toBe("VANTA15");
  });

  it("redeems points below the minimum qualifying order", async () => {
    const quoted = await quote({ quantity: 1, points: 500 });

    expect(quoted.discountAmount).toBe(0);
    expect(quoted.pointsRedeemed).toBeGreaterThan(0);
  });

  // THE CASE THE FIRST REPAIR MISSED, AND THE ONE NOBODY WOULD EVER REPORT:
  // the basket clears the minimum, so "does it qualify" says yes, and the
  // referral still wins nothing.
  it("redeems store credit when a commission-only ambassador's code gives 0%", async () => {
    ambassador.customer_discount_percent = 0;

    const quoted = await quote({ quantity: 3, storeCreditCents: 5000 });

    expect(quoted.referral?.discountPercent).toBe(0);
    expect(quoted.discountAmount).toBe(0);
    expect(quoted.storeCreditRedeemedCents).toBe(5000);
  });

  it("redeems store credit when Buy-3-Get-1 takes the discount over", async () => {
    control.buy3Get1 = true;

    // Four vials: the free item is worth more than 15%, and profit-engine
    // suppresses the referral bucket outright whenever a bundle is present.
    const quoted = await quote({ quantity: 4, storeCreditCents: 5000 });

    expect(quoted.isBuy3Get1Active).toBe(true);
    expect(quoted.storeCreditRedeemedCents).toBe(5000);
  });

  it("redeems store credit when a bigger membership discount wins instead", async () => {
    // 30% membership on the $180.00 list beats the ambassador's 15%.
    const quoted = await quote({ quantity: 3, storeCreditCents: 5000, memberDiscountPercent: 30 });

    expect(quoted.discountAmount).toBeGreaterThan(0);
    expect(quoted.storeCreditRedeemedCents).toBe(5000);
  });

  // The shopper must never be worse off for having clicked the link. This is
  // the invariant the whole rule exists to protect, stated directly.
  it("charges the same as the identical basket with no code at all", async () => {
    const withCode = await quote({ quantity: 1, storeCreditCents: 5000 });
    const withoutCode = await quote({ quantity: 1, withCode: false, storeCreditCents: 5000 });

    expect(withCode.expectedTotal).toBe(withoutCode.expectedTotal);
    expect(withCode.storeCreditRedeemedCents).toBe(withoutCode.storeCreditRedeemedCents);
  });
});
