import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";
import { resolveCartDiscount } from "@/lib/discount-resolution";

// ---------------------------------------------------------------------------
// ONE RULEBOOK FOR EVERY DISCOUNT, AND ATTRIBUTION THAT OUTLIVES ALL OF THEM.
//
// The store's promise to a shopper is "whichever single offer saves you the
// most". The store's promise to an ambassador is "you are paid for the order
// you sent". Those two promises are independent, and the checkout used to
// break both by REFUSING combinations instead of ranking them:
//
//   quote-order threw on referral + coupon      -> the shopper deleted one code
//   quote-order threw on promotion + coupon     -> the shopper deleted one code
//   resolveCustomerDiscount zeroed the referral  -> a promotion always beat it,
//     whatever it was worth (`!isBundle && hasReferral`)
//
// The first two made the SHOPPER choose between codes, and whichever they
// removed, if it was the referral, the ambassador was paid nothing on a sale
// they had made. The third quietly overcharged a shopper whose referral was
// worth more than the promotion it lost to.
//
// So: every non-stackable candidate competes, the largest saving wins, a
// losing code is still recognised, and the referral rides along for
// attribution no matter which one won. Stacking is the ONLY way two land at
// once, and only where the admin has switched it on.
//
// These drive the REAL quoteOrder. Every expected figure is the number a card
// would be charged. The parity block at the bottom re-runs each scenario
// through resolveCartDiscount — the function the cart preview uses — so the
// two can never answer differently again.
// ---------------------------------------------------------------------------

const AMBASSADOR_ID = "amb-competition";
const CODE = "COMPETE";

const ambassador = vi.hoisted(() => ({
  id: "amb-competition",
  name: "Robin Vega",
  email: "robin@ambassadors.test",
  auth_user_id: null as string | null,
  referral_code: "COMPETE",
  commission_percent: 10,
  customer_discount_percent: 10 as number | null,
  status: "approved",
}));

const promotionState = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
  allowCouponStacking: false,
}));

const couponState = vi.hoisted(() => ({
  /** Flat dollars off. 0 means "no coupon row exists for this code". */
  value: 0,
  code: "SAVE",
  freeShipping: false,
}));

const programState = vi.hoisted(() => ({ minimumQualifyingOrder: 1 }));

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

// The only row quoteOrder needs that the mocks below do not supply: the
// ambassador behind the code. Everything else legitimately answers empty.
vi.mock("@/lib/supabase-server", () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.maybeSingle = async () => result;
    self.single = async () => result;
    self.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ ...result, count: 0 }).then(resolve);
    return self;
  };
  const client = {
    from: (table: string) => (table === "ambassadors"
      ? chain({ data: { ...ambassador }, error: null })
      : chain({ data: null, error: null })),
    // No usage limits are set on any promotion here, so the redemption RPCs are
    // never reached; answering null keeps an accidental call visible.
    rpc: async () => ({ data: null, error: null }),
  };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const PRODUCTS = {
  "peptide-a": { name: "Peptide A", category: "Research Peptides", price: "$100.00", stockStatus: "In Stock", image: "/a.png", description: "" },
  "peptide-b": { name: "Peptide B", category: "Research Peptides", price: "$40.00", stockStatus: "In Stock", image: "/b.png", description: "" },
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
      bxgyPromotions: promotionState.promotions,
      bundleStacking: false,
      // Quantity "Bundle & Save" pricing OFF, so every figure below is the work
      // of the candidate under test rather than a tier baked into the subtotal.
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 0, freeShippingThreshold: 1, internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: promotionState.allowCouponStacking }),
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

// quoteOrder reads the qualifying minimum from ambassador-settings, NOT from
// admin-control. Mocking the wrong module here is silent — the real function
// falls through to its coded default of $100 — so a below-minimum scenario
// would quietly test the default instead of the value it set.
vi.mock("@/lib/ambassador-settings", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ambassador-settings");
  return {
    ...actual,
    getAmbassadorProgramSettings: async () => ({
      minimumQualifyingOrder: programState.minimumQualifyingOrder,
      minimumPayoutThreshold: 25,
      commissionHoldDays: 14,
    }),
  };
});

vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  return {
    ...actual,
    validateCoupon: async (code: string | undefined, subtotal: number) => {
      if (!code || couponState.value <= 0) return null;
      return {
        code: couponState.code,
        discountType: "fixed" as const,
        discountValue: couponState.value,
        discountAmount: Math.min(couponState.value, subtotal),
        freeShipping: couponState.freeShipping,
      };
    },
  };
});

const CUSTOMER = {
  email: "shopper@example.test",
  fullName: "Test Shopper",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

function promotion(id: string, overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true, ...overrides };
}

async function quote(input: {
  items: Array<{ id: string; quantity: number }>;
  withReferral?: boolean;
  withCoupon?: boolean;
}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: input.items,
    customer: CUSTOMER,
    referralCode: input.withReferral ? CODE : undefined,
    couponCode: input.withCoupon ? couponState.code : undefined,
    mode: "full",
  });
}

beforeEach(() => {
  // bxgy-promotions.ts memoises "the promotion_id column is missing" for the
  // life of the process, so the module registry has to be reset between tests.
  vi.resetModules();
  ambassador.customer_discount_percent = 10;
  ambassador.status = "approved";
  promotionState.promotions = [];
  promotionState.allowCouponStacking = false;
  couponState.value = 0;
  couponState.code = "SAVE";
  couponState.freeShipping = false;
  programState.minimumQualifyingOrder = 1;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. REFERRAL versus COUPON
// ===========================================================================

describe("referral versus coupon", () => {
  it("gives the shopper the referral when it saves more, and does not record the coupon", async () => {
    ambassador.customer_discount_percent = 25; // $50 of $200
    couponState.value = 20;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.subtotal).toBe(200);
    expect(quoted.discountAmount).toBe(50);
    expect(quoted.discountLabel).toBe("25% referral");
    // The coupon lost, so it took nothing off and must not be redeemed.
    expect(quoted.couponCode).toBeNull();
  });

  it("gives the shopper the coupon when it saves more, and still attributes the referral", async () => {
    ambassador.customer_discount_percent = 25; // $50 of $200
    couponState.value = 80;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.discountAmount).toBe(80);
    expect(quoted.discountLabel).toBe("Coupon");
    expect(quoted.couponCode).toBe("SAVE");
    // THE WHOLE POINT. The ambassador sent this order and is paid for it even
    // though her code is not what lowered the price.
    expect(quoted.referral?.code).toBe(CODE);
    expect(quoted.referral?.ambassadorId).toBe(AMBASSADOR_ID);
  });

  it("does not refuse the order when both codes are present", async () => {
    ambassador.customer_discount_percent = 25;
    couponState.value = 80;

    await expect(quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true }))
      .resolves.toBeDefined();
  });
});

// ===========================================================================
// 2. REFERRAL versus PROMOTION
// ===========================================================================

describe("referral versus promotion", () => {
  it("gives the shopper the promotion when it saves more, and still attributes the referral", async () => {
    // 4 x $40 = $160. Buy 1 Get 1 Free -> two free units = $80.
    // A 10% referral is worth $16.
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    ambassador.customer_discount_percent = 10;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(quoted.discountAmount).toBe(80);
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
    expect(quoted.referral?.code).toBe(CODE);
  });

  it("gives the shopper the referral when it saves more, and consumes no promotion redemption", async () => {
    // 4 x $40 = $160. Buy 3 Get 1 Free -> one free unit = $40.
    // A 40% referral is worth $64, so the shopper is better off with the code.
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    ambassador.customer_discount_percent = 40;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(quoted.discountAmount).toBe(64);
    expect(quoted.discountLabel).toBe("40% referral");
    // A promotion that did not price the order must not be written to it, or a
    // limited promotion would burn a redemption it never gave.
    expect(quoted.appliedPromotionId).toBeNull();
    expect(quoted.referral?.code).toBe(CODE);
  });
});

// ===========================================================================
// 3. COUPON versus PROMOTION
// ===========================================================================

describe("coupon versus promotion", () => {
  it("gives the shopper the promotion when it saves more, and does not record the coupon", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")]; // $80 on 4 x $40
    couponState.value = 30;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true });

    expect(quoted.discountAmount).toBe(80);
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
    expect(quoted.couponCode).toBeNull();
  });

  it("gives the shopper the coupon when it saves more, and consumes no promotion redemption", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")]; // $40 on 4 x $40
    couponState.value = 70;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true });

    expect(quoted.discountAmount).toBe(70);
    expect(quoted.couponCode).toBe("SAVE");
    expect(quoted.appliedPromotionId).toBeNull();
  });

  it("does not refuse the order when a coupon meets a promotion", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    couponState.value = 30;

    await expect(quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true }))
      .resolves.toBeDefined();
  });
});

// ===========================================================================
// 4. STACKING — the only way two discounts land at once
// ===========================================================================

describe("stacking, and only where it is switched on", () => {
  it("adds a coupon to a promotion that allows stacking", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { stackWithCoupon: true })];
    couponState.value = 30;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true });

    expect(quoted.discountAmount).toBe(110); // $80 promotion + $30 coupon
    expect(quoted.couponCode).toBe("SAVE");
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
  });

  it("adds a coupon to a referral when the store-wide switch allows stacking", async () => {
    promotionState.allowCouponStacking = true;
    ambassador.customer_discount_percent = 25; // $50 of $200
    couponState.value = 20;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.discountAmount).toBe(70);
    expect(quoted.couponCode).toBe("SAVE");
    expect(quoted.referral?.code).toBe(CODE);
  });

  it("keeps a promotion and a referral exclusive even while coupon stacking is on", async () => {
    // Coupon stacking says nothing about the promotion/referral contest: those
    // two still compete, and only the better one is given.
    promotionState.allowCouponStacking = true;
    promotionState.promotions = [promotion("buy-1-get-1-free")]; // $80 on 4 x $40
    ambassador.customer_discount_percent = 10; // $16

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(quoted.discountAmount).toBe(80);
  });
});

// ===========================================================================
// 5. ATTRIBUTION SURVIVES EVERY LOSS
// ===========================================================================

describe("referral attribution is never removed by another discount winning", () => {
  it("keeps the code and the ambassador when a coupon wins", async () => {
    ambassador.customer_discount_percent = 5;
    couponState.value = 90;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.discountLabel).toBe("Coupon");
    expect(quoted.referral?.code).toBe(CODE);
    expect(quoted.referral?.ambassadorId).toBe(AMBASSADOR_ID);
  });

  it("keeps the code and the ambassador when a promotion wins", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    ambassador.customer_discount_percent = 5;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
    expect(quoted.referral?.code).toBe(CODE);
    expect(quoted.referral?.ambassadorId).toBe(AMBASSADOR_ID);
  });

  it("keeps the code and the ambassador when a stacked coupon and promotion win together", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { stackWithCoupon: true })];
    couponState.value = 30;
    ambassador.customer_discount_percent = 5;

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true, withCoupon: true });

    expect(quoted.discountAmount).toBe(110);
    expect(quoted.referral?.code).toBe(CODE);
  });

  it("keeps the code below the programme minimum, where the referral is worth nothing", async () => {
    programState.minimumQualifyingOrder = 500;
    ambassador.customer_discount_percent = 25;
    couponState.value = 20;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    // The referral cannot compete, so the coupon is simply the best offer.
    expect(quoted.discountAmount).toBe(20);
    expect(quoted.couponCode).toBe("SAVE");
    expect(quoted.referral?.code).toBe(CODE);
  });

  it("commissions the NET merchandise the shopper actually paid for", async () => {
    // The commission base both paid lanes derive is `subtotal - discount_amount`
    // (accrueCommissionForPaidOrder). Pinned here at the quote, so a change to
    // what checkout writes cannot silently change what an ambassador is owed.
    ambassador.customer_discount_percent = 5;
    couponState.value = 80;

    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.subtotal - quoted.discountAmount).toBe(120);
  });
});

// ===========================================================================
// 6. THE WINNER FOLLOWS THE BASKET
// ===========================================================================

describe("changing the cart re-runs the contest", () => {
  it("hands the win from the coupon to the referral as the basket grows", async () => {
    ambassador.customer_discount_percent = 25;
    couponState.value = 60;

    // $200 basket: the referral is worth $50, the coupon $60.
    const small = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });
    expect(small.discountAmount).toBe(60);
    expect(small.couponCode).toBe("SAVE");

    // $400 basket: the referral is now worth $100 and takes the win back. Same
    // two codes, no shopper action, different winner.
    const large = await quote({ items: [{ id: "peptide-a", quantity: 4 }], withReferral: true, withCoupon: true });
    expect(large.discountAmount).toBe(100);
    expect(large.discountLabel).toBe("25% referral");
    expect(large.couponCode).toBeNull();

    // And the ambassador is attributed on both.
    expect(small.referral?.code).toBe(CODE);
    expect(large.referral?.code).toBe(CODE);
  });

  it("hands the win from the referral to the promotion as the basket grows", async () => {
    // 2 x $40 = $80. Buy 3 Get 1 needs four units, so nothing is earned yet and
    // the 30% referral ($24) is the only offer.
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    ambassador.customer_discount_percent = 30;

    const small = await quote({ items: [{ id: "peptide-b", quantity: 2 }], withReferral: true });
    expect(small.discountAmount).toBe(24);
    expect(small.appliedPromotionId).toBeNull();

    // 8 x $40 = $320. The promotion frees two units ($80); 30% is $96, so the
    // referral still wins — and the promotion still consumes nothing.
    const large = await quote({ items: [{ id: "peptide-b", quantity: 8 }], withReferral: true });
    expect(large.discountAmount).toBe(96);
    expect(large.appliedPromotionId).toBeNull();
  });
});

// ===========================================================================
// 7. THE CART PREVIEW AND THE CARD AGREE
// ===========================================================================

describe("the cart's rulebook answers exactly what the checkout charges", () => {
  /**
   * The cart's assembly, given what it knows. Deliberately built from the same
   * raw candidate amounts quoteOrder feeds resolveCustomerDiscount, because
   * that is what "client and server use the same rules" has to mean: same
   * inputs in, same number out.
   */
  function cartShows(input: {
    subtotal: number;
    promotionAmount?: number;
    referralPercent?: number;
    couponAmount?: number;
    allowCouponStacking?: boolean;
  }) {
    return resolveCartDiscount({
      subtotal: input.subtotal,
      quantityBundleSavings: 0,
      bulkSavingsAmount: 0,
      memberPricingAmount: 0,
      ambassadorPersonalAmount: 0,
      couponDiscountAmount: input.couponAmount ?? 0,
      allowCouponStacking: input.allowCouponStacking ?? false,
      promos: [
        ...(input.promotionAmount ? [{ type: "buy3get1" as const, amount: input.promotionAmount }] : []),
        ...(input.referralPercent
          ? [{ type: "referral" as const, amount: input.subtotal * (input.referralPercent / 100) }]
          : []),
      ],
    }).amount;
  }

  it("agrees when the referral beats the coupon", async () => {
    ambassador.customer_discount_percent = 25;
    couponState.value = 20;
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(cartShows({ subtotal: 200, referralPercent: 25, couponAmount: 20 })).toBe(quoted.discountAmount);
  });

  it("agrees when the coupon beats the referral", async () => {
    ambassador.customer_discount_percent = 25;
    couponState.value = 80;
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(cartShows({ subtotal: 200, referralPercent: 25, couponAmount: 80 })).toBe(quoted.discountAmount);
  });

  it("agrees when the promotion beats the referral", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    ambassador.customer_discount_percent = 10;
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(cartShows({ subtotal: 160, promotionAmount: 80, referralPercent: 10 })).toBe(quoted.discountAmount);
  });

  it("agrees when the referral beats the promotion", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    ambassador.customer_discount_percent = 40;
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withReferral: true });

    expect(cartShows({ subtotal: 160, promotionAmount: 40, referralPercent: 40 })).toBe(quoted.discountAmount);
  });

  it("agrees when the coupon beats the promotion", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    couponState.value = 70;
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true });

    expect(cartShows({ subtotal: 160, promotionAmount: 40, couponAmount: 70 })).toBe(quoted.discountAmount);
  });

  it("agrees when a stacked coupon rides on the promotion", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { stackWithCoupon: true })];
    couponState.value = 30;
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], withCoupon: true });

    expect(cartShows({ subtotal: 160, promotionAmount: 80, couponAmount: 30, allowCouponStacking: true }))
      .toBe(quoted.discountAmount);
  });

  it("agrees when a stacked coupon rides on the referral", async () => {
    promotionState.allowCouponStacking = true;
    ambassador.customer_discount_percent = 25;
    couponState.value = 20;
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(cartShows({ subtotal: 200, referralPercent: 25, couponAmount: 20, allowCouponStacking: true }))
      .toBe(quoted.discountAmount);
  });
});
