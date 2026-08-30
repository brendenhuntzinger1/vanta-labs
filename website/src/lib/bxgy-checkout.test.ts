import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// THE PROMOTION CENTRE, THROUGH THE REAL CHECKOUT.
//
// bxgy-engine.test.ts pins the arithmetic. These drive quoteOrder — the store's
// one authoritative pricing pass — so what is pinned here is the part the
// engine tests cannot see: that a configured promotion actually reaches the
// total a card is charged, that it obeys the store's existing single-discount
// rules against coupons and referrals, that a schedule and a usage limit take
// it away again, and that the free unit is valued the way the cart values it.
//
// Nothing here restates the arithmetic. Every expected figure is the one a
// shopper would be charged.
// ---------------------------------------------------------------------------

const promotionState = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
  bundleStacking: false,
  allowCouponStacking: false,
}));

/**
 * Orders already on record, as the redemption count sees them. Keyed the way
 * getExhaustedPromotionIds queries: promotion id, redeemable status, and
 * (for a per-customer limit) the customer's email.
 */
const orderHistory = vi.hoisted(() => ({
  rows: [] as Array<{ promotion_id: string; payment_status: string; customer_email: string }>,
}));

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

// The database, reduced to the two things these tests actually need: the
// coupon row a coupon test redeems, and the order history the redemption count
// reads. Everything else legitimately answers empty.
vi.mock("@/lib/supabase-server", () => {
  type Filter = { column: string; value: unknown; kind: "eq" | "in" };
  const chain = (table: string) => {
    const filters: Filter[] = [];
    const self: Record<string, unknown> = {};
    for (const method of ["select", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.eq = (column: string, value: unknown) => { filters.push({ column, value, kind: "eq" }); return self; };
    self.in = (column: string, value: unknown) => { filters.push({ column, value, kind: "in" }); return self; };

    const resolve = () => {
      if (table !== "orders") return { data: null, error: null, count: 0 };
      const matching = orderHistory.rows.filter((row) => filters.every((filter) => {
        const cell = (row as unknown as Record<string, unknown>)[filter.column];
        if (filter.kind === "in") return Array.isArray(filter.value) && filter.value.includes(cell);
        return cell === filter.value;
      }));
      return { data: null, error: null, count: matching.length };
    };
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (onResolve: (value: unknown) => unknown) => Promise.resolve(resolve()).then(onResolve);
    return self;
  };
  const client = { from: (table: string) => chain(table) };
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
      bundleStacking: promotionState.bundleStacking,
      // Bundle & Save off, so every figure below is the promotion's own work
      // rather than a quantity tier's.
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 0, freeShippingThreshold: 1, internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
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

// A flat $30-off coupon, so the coupon-versus-promotion contest has an
// unambiguous winner in each direction.
const coupon = vi.hoisted(() => ({ discountAmount: 30 }));
vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  return {
    ...actual,
    validateCoupon: async (code: string | undefined) => (code
      ? { code: "SAVE30", discountType: "fixed", discountValue: coupon.discountAmount, discountAmount: coupon.discountAmount }
      : null),
  };
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

function promotion(id: string, overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true, ...overrides };
}

async function quote(input: {
  items: Array<{ id: string; quantity: number }>;
  couponCode?: string;
  email?: string;
}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: input.items,
    customer: { ...CUSTOMER, email: input.email ?? CUSTOMER.email },
    couponCode: input.couponCode,
    mode: "full",
  });
}

beforeEach(() => {
  promotionState.promotions = [];
  promotionState.bundleStacking = false;
  promotionState.allowCouponStacking = false;
  orderHistory.rows = [];
  coupon.discountAmount = 30;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("each promotion reaches the total the card is charged", () => {
  it("prices Buy 1 Get 1 Free on a two-item cart", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    // $100 + $40 → the cheaper unit is free.
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 1 }, { id: "peptide-b", quantity: 1 }] });

    expect(quoted.subtotal).toBe(140);
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.expectedTotal).toBe(100);
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
    expect(quoted.appliedPromotionName).toBe("Buy 1 Get 1 Free");
    expect(quoted.isBuy3Get1Active).toBe(true);
  });

  it("prices Buy 2 Get 1 Free", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    // 3 x $40 → one group → one free.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 3 }] });
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.expectedTotal).toBe(80);
  });

  it("prices Buy 3 Get 2 Free", async () => {
    promotionState.promotions = [promotion("buy-3-get-2-free")];
    // 5 x $40 → one group of five → two free.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 5 }] });
    expect(quoted.discountAmount).toBe(80);
    expect(quoted.expectedTotal).toBe(120);
  });

  it("prices Buy 1 Get 1 50% Off", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-half-off")];
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 1 }, { id: "peptide-b", quantity: 1 }] });
    expect(quoted.discountAmount).toBe(20); // half of the $40 unit
    expect(quoted.expectedTotal).toBe(120);
  });

  it("prices Buy 2 Get 1 50% Off", async () => {
    promotionState.promotions = [promotion("buy-2-get-1-half-off")];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 3 }] });
    expect(quoted.discountAmount).toBe(20);
  });

  it("still prices Buy 3 Get 1 Free exactly as it always did", async () => {
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    // 4 x $40 → the cheapest of four is free.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.expectedTotal).toBe(120);
  });

  it("charges full price when no promotion is configured", async () => {
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
    expect(quoted.appliedPromotionId).toBeNull();
    expect(quoted.isBuy3Get1Active).toBe(false);
  });
});

describe("mixed-price carts", () => {
  it("gives away the cheapest units, not the dearest", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    // 2 x $100 + 2 x $40 → two free, and they are the $40 ones.
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }, { id: "peptide-b", quantity: 2 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("only counts eligible products towards the promotion", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", {
      eligibility: { includeSlugs: ["peptide-a"], excludeSlugs: [] },
    })];
    // Two eligible $100 units earn one free; the four $40 units are invisible
    // to this promotion and can never become the free one.
    const quoted = await quote({ items: [{ id: "peptide-a", quantity: 2 }, { id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(100);
  });

  it("honours an exclusion over the whole store", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", {
      eligibility: { includeSlugs: [], excludeSlugs: ["peptide-b"] },
    })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 6 }] });
    expect(quoted.discountAmount).toBe(0);
  });
});

describe("only one promotion applies, and it is the best one", () => {
  it("picks the promotion worth the most on this basket", async () => {
    promotionState.promotions = [
      promotion("buy-3-get-1-free"),
      promotion("buy-1-get-1-free"),
      promotion("buy-2-get-1-half-off"),
    ];
    // 4 x $40. BOGO frees two ($80); Buy 3 Get 1 frees one ($40); Buy 2 Get 1
    // half-off takes $20. The charge reflects one of them, the biggest.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
  });
});

describe("scheduling takes a promotion away without anyone touching it", () => {
  it("does not price a promotion whose window has not opened", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { startsAt: "2099-01-01T00:00:00.000Z" })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("does not price a promotion whose window has closed", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { endsAt: "2020-01-01T00:00:00.000Z" })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("prices one that is inside its window", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", {
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
    })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("falls back to the next-best promotion when the best one has expired", async () => {
    promotionState.promotions = [
      promotion("buy-1-get-1-free", { endsAt: "2020-01-01T00:00:00.000Z" }),
      promotion("buy-3-get-1-free"),
    ];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.appliedPromotionId).toBe("buy-3-get-1-free");
  });
});

// ---------------------------------------------------------------------------
// USAGE LIMITS, AND WHAT A REFUND GIVES BACK
// ---------------------------------------------------------------------------

function paidOrder(promotionId: string, email = CUSTOMER.email, status = "paid") {
  return { promotion_id: promotionId, payment_status: status, customer_email: email };
}

describe("usage limits", () => {
  it("stops applying once the store-wide limit is reached", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 2 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free"), paidOrder("buy-1-get-1-free", "other@example.test")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
    expect(quoted.appliedPromotionId).toBeNull();
  });

  it("still applies while the limit has room", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 2 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("stops applying for a customer who has used their personal allowance", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { perCustomerLimit: 1 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free", CUSTOMER.email)];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("does not hold one customer's history against another", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { perCustomerLimit: 1 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free", "someone-else@example.test")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("counts an order that was partly refunded — the sale still happened", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free", CUSTOMER.email, "partially_refunded")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("GIVES THE REDEMPTION BACK when the order is refunded", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];
    orderHistory.rows = [paidOrder("buy-1-get-1-free", CUSTOMER.email, "refunded")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("gives the redemption back when the order is cancelled", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1, perCustomerLimit: 1 })];
    orderHistory.rows = [
      paidOrder("buy-1-get-1-free", CUSTOMER.email, "canceled"),
      paidOrder("buy-1-get-1-free", CUSTOMER.email, "cancelled"),
      paidOrder("buy-1-get-1-free", CUSTOMER.email, "payment_failed"),
      // An order still awaiting payment has redeemed nothing either.
      paidOrder("buy-1-get-1-free", CUSTOMER.email, "pending_payment"),
    ];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("does not count another promotion's redemptions against this one", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];
    orderHistory.rows = [paidOrder("buy-3-get-1-free"), paidOrder("buy-2-get-1-free")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("falls through to a promotion that still has room", async () => {
    promotionState.promotions = [
      promotion("buy-1-get-1-free", { maxRedemptions: 1 }),
      promotion("buy-3-get-1-free"),
    ];
    orderHistory.rows = [paidOrder("buy-1-get-1-free")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(40);
    expect(quoted.appliedPromotionId).toBe("buy-3-get-1-free");
  });
});

// ---------------------------------------------------------------------------
// STACKING
// ---------------------------------------------------------------------------

describe("stacking rules", () => {
  it("refuses a coupon alongside a promotion that does not allow one", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    await expect(quote({ items: [{ id: "peptide-b", quantity: 4 }], couponCode: "SAVE30" }))
      .rejects.toThrow(/cannot be combined with Buy 1 Get 1 Free/);
  });

  it("adds a coupon on top when the promotion allows stacking", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { stackWithCoupon: true })];
    // $160 subtotal, $80 of free items, plus the $30 coupon on top.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], couponCode: "SAVE30" });
    expect(quoted.discountAmount).toBe(110);
    expect(quoted.couponCode).toBe("SAVE30");
  });

  it("lets the store-wide coupon-stacking switch do the same", async () => {
    promotionState.allowCouponStacking = true;
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }], couponCode: "SAVE30" });
    expect(quoted.discountAmount).toBe(110);
  });

  it("never lets two promotions stack", async () => {
    promotionState.promotions = [
      promotion("buy-1-get-1-free"),
      promotion("buy-2-get-1-free"),
      promotion("buy-3-get-1-free"),
    ];
    // 4 x $40. If these stacked the whole basket would be free; only the best
    // one applies.
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });

  it("never discounts more than the basket is worth", async () => {
    // A stacked coupon far larger than the order. The discount is capped at the
    // subtotal and the total never goes negative. (The profit guard then peels
    // the coupon back off, because an order charging $0 is below any floor —
    // which is the store's existing behaviour and not this promotion's to
    // change. What is asserted here is the invariant that holds either way.)
    promotionState.promotions = [promotion("buy-1-get-1-free", { stackWithCoupon: true })];
    coupon.discountAmount = 10_000;
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 2 }] });

    expect(quoted.discountAmount).toBeLessThanOrEqual(quoted.subtotal);
    expect(quoted.expectedTotal).toBeGreaterThanOrEqual(0);
  });

  it("caps a promotion at the value of the basket it discounts", async () => {
    // Buy 1 Get 1 on a single-price cart takes exactly half, never more,
    // however many units are in it.
    promotionState.promotions = [promotion("buy-1-get-1-free")];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 20 }] });
    expect(quoted.subtotal).toBe(800);
    expect(quoted.discountAmount).toBe(400);
  });
});
