import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// A GIFT IS ONLY "APPLIED" WHEN IT ACTUALLY CHANGED THE TOTAL.
//
// The 2026-09-04 audit reproduced this on the harness: a 15% welcome gift plus
// a 50% coupon priced the coupon, told the shopper "15% off" was applied, and
// reserved the token — which the paid webhook then consumed permanently for
// $0 of benefit. The gift's percentage competes in the store's single-best-
// discount rule (deliberately, and unchanged here); what was wrong is that
// quoteOrder reported and reserved the gift for what it PROMISED rather than
// for what it GRANTED.
//
// So, driven through the real quoteOrder:
//   * a percentage-only gift that loses the race is not applied, not described,
//     and (because appliedOffer is null) never reserved or burned;
//   * a combined gift keeps the halves that did apply and drops the ones that
//     did not from its description;
//   * a free-shipping gift that waives nothing (shipping was already free) is
//     not applied either;
//   * a typed coupon that lost to the gift is not recorded on the order, so it
//     is not redeemed for a discount it never gave;
//   * the minimum is judged on what the customer actually pays for merchandise
//     after every OTHER discount — the "qualifying subtotal" — so a $40 basket
//     with a 50% coupon cannot collect a $35-minimum gift on $20 of goods.
// ---------------------------------------------------------------------------

type OfferRow = {
  id: string; offer_key: string; email: string; reward_kind: string;
  product_slug: string | null; percent_off: number | null; variant_id: string | null;
  min_subtotal_cents: number; expires_at: string; reserved_order_id: string | null; redeemed_at: string | null;
};

const state = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
  offer: null as OfferRow | null,
  member: { percent: 0, freeShipping: false },
  bundle: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
  shipping: { domesticFee: 15, freeShippingThreshold: 200 },
  couponStacking: false,
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    peekCustomerOffer: async (input: { token: string; email: string }) =>
      state.offer && state.offer.email === input.email.toLowerCase() ? state.offer : null,
  };
});

/** Three codes, no database: a big one, a small one, and a shipping waiver. */
vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  const calculate = actual.calculateCouponDiscount as (subtotal: number, type: "percent" | "fixed", value: number) => number;
  const CODES: Record<string, { percent: number; freeShipping: boolean }> = {
    SAVE50: { percent: 50, freeShipping: false },
    SAVE5: { percent: 5, freeShipping: false },
    SAVE10: { percent: 10, freeShipping: false },
    SHIPFREE: { percent: 0, freeShipping: true },
  };
  return {
    ...actual,
    validateCoupon: async (code: string | undefined, subtotal: number) => {
      const key = String(code ?? "").trim().toUpperCase();
      const found = CODES[key];
      if (!found) throw new Error("Invalid coupon code.");
      return { code: key, discountType: "percent", discountValue: found.percent, discountAmount: calculate(subtotal, "percent", found.percent), freeShipping: found.freeShipping };
    },
  };
});

vi.mock("@/lib/membership", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/membership");
  return {
    ...actual,
    getMembershipPerks: async () => ({
      isActiveMember: state.member.percent > 0 || state.member.freeShipping,
      tierSlug: state.member.percent > 0 ? "elite" : "free",
      memberDiscountPercent: state.member.percent,
      freeShipping: state.member.freeShipping,
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
  // The ambassador self-purchase check resolves a signed-in customer's address
  // through the auth admin API; a member here is nobody's ambassador.
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
  "vial-70": { name: "Vial 70", category: "Research Peptides", price: "$70.00", stockStatus: "In Stock", image: "/c.png", description: "" },
  "vial-6998": { name: "Vial 69.98", category: "Research Peptides", price: "$69.98", stockStatus: "In Stock", image: "/d.png", description: "" },
  "vial-37": { name: "Vial 37", category: "Research Peptides", price: "$37.00", stockStatus: "In Stock", image: "/e.png", description: "" },
  "ghk-cu": { name: "GHK-Cu", category: "Research Peptides", price: "$47.99", stockStatus: "In Stock", image: "/g.png", description: "" },
  "bacteriostatic-water": { name: "BAC Water", category: "Supplies", price: "$9.99", stockStatus: "In Stock", image: "/w.png", description: "" },
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
    getHomepageControlConfig: async () => ({ bxgyPromotions: state.promotions, bundleStacking: false, bundleConfig: state.bundle }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({
      domesticFee: state.shipping.domesticFee, freeShippingThreshold: state.shipping.freeShippingThreshold,
      northAmericaFee: 25, northAmericaFreeShippingThreshold: 400,
      internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0,
    }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: state.couponStacking }),
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
  email: "lapsed@example.test", fullName: "Lapsed Buyer", address: "1 Test Street",
  city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100",
};

function promotion(id: string): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true };
}

const base: OfferRow = {
  id: "offer-1", offer_key: "winback_60_percent_15", email: CUSTOMER.email, reward_kind: "percent",
  product_slug: null, percent_off: 15, variant_id: null, min_subtotal_cents: 3500,
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), reserved_order_id: null, redeemed_at: null,
};
const percent15 = (): OfferRow => ({ ...base });
const bacWater10 = (): OfferRow => ({ ...base, offer_key: "winback_60_bac_water_10", reward_kind: "free_product_percent", product_slug: "bacteriostatic-water", percent_off: 10 });
const freeShipping = (): OfferRow => ({ ...base, offer_key: "winback_60_free_shipping", reward_kind: "free_shipping", percent_off: null });
const freeGhk = (): OfferRow => ({ ...base, offer_key: "winback_60_free_ghkcu", reward_kind: "free_product", product_slug: "ghk-cu", percent_off: null, min_subtotal_cents: 6000 });

async function quote(items: Array<{ id: string; quantity: number }>, opts: { couponCode?: string; member?: boolean } = {}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items, customer: CUSTOMER, offerToken: "token", mode: "full",
    couponCode: opts.couponCode, customerUserId: opts.member ? "user-1" : undefined,
  });
}

beforeEach(() => {
  vi.resetModules();
  state.promotions = [];
  state.offer = null;
  state.member = { percent: 0, freeShipping: false };
  state.bundle = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 };
  state.shipping = { domesticFee: 15, freeShippingThreshold: 200 };
  state.couponStacking = false;
});

describe("a 15% gift against the other discounts", () => {
  it("LOSES to a larger coupon: the coupon prices the order and the gift is not applied, described, or reservable", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(40);
    expect(q.couponCode).toBe("SAVE50");
    expect(q.appliedOffer).toBeNull();
    expect(q.discountLabel).toBe("Coupon");
  });

  it("BEATS a smaller coupon: the gift prices the order, and the losing code is not recorded (so it is not redeemed)", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SAVE5" });
    expect(q.discountAmount).toBe(12);
    expect(q.appliedOffer?.description).toBe("15% off");
    expect(q.appliedOffer?.percentApplied).toBe(true);
    expect(q.couponCode).toBeNull();
    expect(q.discountLabel).toBe("15% gift");
  });

  it("a shipping-waiving coupon that lost the percentage is still recorded, because it still waived shipping", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SHIPFREE" });
    expect(q.discountAmount).toBe(12);
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer?.description).toBe("15% off");
    expect(q.couponCode).toBe("SHIPFREE");
  });

  it("LOSES to better member pricing", async () => {
    state.offer = percent15();
    state.member = { percent: 20, freeShipping: false };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { member: true });
    expect(q.discountAmount).toBe(16);
    expect(q.discountLabel).toBe("Membership pricing");
    expect(q.appliedOffer).toBeNull();
  });

  it("BEATS weaker member pricing", async () => {
    state.offer = percent15();
    state.member = { percent: 10, freeShipping: false };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { member: true });
    expect(q.discountAmount).toBe(12);
    expect(q.appliedOffer?.description).toBe("15% off");
  });

  it("LOSES to a quantity tier that already saves more than it would", async () => {
    state.offer = percent15();
    state.bundle = { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0.2 };
    // 10 x $40 = $400 list, $320 after the 20% tier. 15% of $400 is $60, less
    // than the $80 already granted, so the gift is worth nothing here.
    const q = await quote([{ id: "peptide-b", quantity: 10 }]);
    expect(q.subtotal).toBe(320);
    expect(q.discountAmount).toBe(0);
    expect(q.appliedOffer).toBeNull();
  });

  it("applies only its value BEYOND a smaller quantity tier, and says so", async () => {
    state.offer = percent15();
    state.bundle = { twoUnitPercent: 0, threePlusPercent: 0.08, fiveUnitPercent: 0, tenUnitPercent: 0 };
    // 3 x $40 = $120 list, $110.40 after 8%. 15% of $120 = $18, minus the $9.60
    // already granted = $8.40 more off.
    const q = await quote([{ id: "peptide-b", quantity: 3 }]);
    expect(q.subtotal).toBe(110.4);
    expect(q.discountAmount).toBe(8.4);
    expect(q.appliedOffer?.description).toBe("15% off");
  });

  it("LOSES to a Buy 3 Get 1 promotion worth more", async () => {
    state.offer = percent15();
    state.promotions = [promotion("buy-3-get-1-free")];
    // 4 x $40: the promotion gives a $40 unit; 15% of $160 is only $24.
    const q = await quote([{ id: "peptide-b", quantity: 4 }]);
    expect(q.discountAmount).toBe(40);
    expect(q.appliedPromotionId).toBe("buy-3-get-1-free");
    expect(q.appliedOffer).toBeNull();
  });

  it("with coupon stacking switched on, the gift adds on top and is applied", async () => {
    state.offer = percent15();
    state.couponStacking = true;
    state.member = { percent: 10, freeShipping: false };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { member: true });
    // membership $8 + gift $12
    expect(q.discountAmount).toBe(20);
    expect(q.appliedOffer?.percentApplied).toBe(true);
  });
});

describe("10% off + a free BAC water", () => {
  it("keeps the free vial and drops the 10% from its description when a bigger discount wins", async () => {
    state.offer = bacWater10();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(40);
    expect(q.lineItems.find((line) => line.gift)?.product.name).toBe("BAC Water");
    expect(q.appliedOffer?.description).toBe("BAC Water");
    expect(q.appliedOffer?.productApplied).toBe(true);
    expect(q.appliedOffer?.percentApplied).toBe(false);
  });

  it("names both halves when its 10% actually wins", async () => {
    state.offer = bacWater10();
    const q = await quote([{ id: "peptide-b", quantity: 2 }]);
    expect(q.discountAmount).toBe(8);
    expect(q.appliedOffer?.description).toBe("BAC Water + 10% off");
    expect(q.appliedOffer?.percentApplied).toBe(true);
    expect(q.discountLabel).toBe("10% gift");
  });
});

describe("a free-shipping gift", () => {
  it("is applied when the order would otherwise pay shipping", async () => {
    state.offer = freeShipping();
    const q = await quote([{ id: "peptide-b", quantity: 2 }]);
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer?.description).toBe("Free shipping");
    expect(q.appliedOffer?.shippingApplied).toBe(true);
  });

  it("is NOT applied when the store already ships this order free", async () => {
    state.offer = freeShipping();
    // 6 x $40 = $240, over the $200 threshold: the gift waives nothing.
    const q = await quote([{ id: "peptide-b", quantity: 6 }]);
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer).toBeNull();
  });

  it("is NOT applied for a member whose plan already includes free shipping", async () => {
    state.offer = freeShipping();
    state.member = { percent: 0, freeShipping: true };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { member: true });
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer).toBeNull();
  });
});

describe("the qualifying subtotal: what the customer actually pays for merchandise", () => {
  it("a $40 basket with a 50% coupon pays $20 of goods and does not reach a $35 gift", async () => {
    state.offer = freeShipping();
    const q = await quote([{ id: "peptide-b", quantity: 1 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(20);
    expect(q.shipping).toBe(15);
    expect(q.appliedOffer).toBeNull();
  });

  it("a typed code that will LOSE to the gift's percentage does not count against the minimum: $37 with a 10% code and a 15% gift qualifies on $37", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "vial-37", quantity: 1 }], { couponCode: "SAVE10" });
    expect(q.discountAmount).toBe(5.55);
    expect(q.appliedOffer?.percentApplied).toBe(true);
    expect(q.couponCode).toBeNull();
  });

  it("a typed code that WINS does count: $37 with a 50% code pays $18.50 and the gift is withdrawn", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "vial-37", quantity: 1 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(18.5);
    expect(q.appliedOffer).toBeNull();
    expect(q.couponCode).toBe("SAVE50");
  });

  it("a free-shipping code that waived nothing (the order already ships free) is not recorded when the gift takes the slot", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 6 }], { couponCode: "SHIPFREE" });
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer?.percentApplied).toBe(true);
    expect(q.couponCode).toBeNull();
  });

  it("a free-shipping code that DID waive shipping is recorded even though the gift took the percentage slot", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SHIPFREE" });
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer?.percentApplied).toBe(true);
    expect(q.couponCode).toBe("SHIPFREE");
  });

  it("exactly $35 of paid merchandise qualifies", async () => {
    state.offer = freeShipping();
    const q = await quote([{ id: "vial-70", quantity: 1 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(35);
    expect(q.shipping).toBe(0);
    expect(q.appliedOffer?.description).toBe("Free shipping");
  });

  it("$34.99 of paid merchandise does not", async () => {
    state.offer = freeShipping();
    const q = await quote([{ id: "vial-6998", quantity: 1 }], { couponCode: "SAVE50" });
    expect(q.discountAmount).toBe(34.99);
    expect(q.shipping).toBe(15);
    expect(q.appliedOffer).toBeNull();
  });

  it("the free GHK-Cu needs $60 of paid merchandise: $80 with a 50% coupon is $40, so no vial", async () => {
    state.offer = freeGhk();
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { couponCode: "SAVE50" });
    expect(q.lineItems.some((line) => line.gift)).toBe(false);
    expect(q.appliedOffer).toBeNull();
    expect(q.discountAmount).toBe(40);
  });

  it("the same $80 basket with no coupon gets the vial", async () => {
    state.offer = freeGhk();
    const q = await quote([{ id: "peptide-b", quantity: 2 }]);
    expect(q.lineItems.find((line) => line.gift)?.product.name).toBe("GHK-Cu");
    expect(q.appliedOffer?.description).toBe("GHK-Cu");
  });

  it("a legitimate Buy 3 Get 1 order still qualifies on what it pays: 4 x $40 minus a free unit is $120", async () => {
    state.offer = freeGhk();
    state.promotions = [promotion("buy-3-get-1-free")];
    const q = await quote([{ id: "peptide-b", quantity: 4 }]);
    expect(q.discountAmount).toBe(40);
    expect(q.appliedPromotionId).toBe("buy-3-get-1-free");
    expect(q.lineItems.find((line) => line.gift)?.product.name).toBe("GHK-Cu");
    expect(q.appliedOffer?.description).toBe("GHK-Cu");
  });

  it("the gift's OWN percentage never counts against its minimum: $40 with a 15% gift qualifies at $40, not $34", async () => {
    state.offer = percent15();
    const q = await quote([{ id: "peptide-b", quantity: 1 }]);
    expect(q.discountAmount).toBe(6);
    expect(q.appliedOffer?.description).toBe("15% off");
  });

  it("member pricing counts: $80 at 20% member pricing is $64, which is still over $60 for the vial", async () => {
    state.offer = freeGhk();
    state.member = { percent: 20, freeShipping: false };
    const q = await quote([{ id: "peptide-b", quantity: 2 }], { member: true });
    expect(q.discountAmount).toBe(16);
    expect(q.appliedOffer?.description).toBe("GHK-Cu");
  });

  it("member pricing counts: $70 at 20% is $56, under $60, so no vial", async () => {
    state.offer = freeGhk();
    state.member = { percent: 20, freeShipping: false };
    const q = await quote([{ id: "vial-70", quantity: 1 }], { member: true });
    expect(q.discountAmount).toBe(14);
    expect(q.lineItems.some((line) => line.gift)).toBe(false);
    expect(q.appliedOffer).toBeNull();
  });
});
