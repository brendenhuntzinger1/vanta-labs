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
  /** Simulate a database on which bxgy-promotions.sql has not been applied. */
  promotionColumnMissing: false,
  /** Simulate a transient failure (statement timeout, RLS refusal). */
  transientError: false,
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
      if (orderHistory.promotionColumnMissing) {
        // Exactly what PostgREST answers for an unknown column.
        return { data: null, error: { code: "42703", message: 'column orders.promotion_id does not exist' }, count: null };
      }
      if (orderHistory.transientError) {
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" }, count: null };
      }
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
  // bxgy-promotions.ts memoises "the promotion_id column is missing" for the
  // life of the process — deliberately, so one failed count does not become one
  // per checkout. That memo has to be reset between tests, or the first
  // missing-column case would silently poison every test after it.
  vi.resetModules();
  promotionState.promotions = [];
  promotionState.bundleStacking = false;
  promotionState.allowCouponStacking = false;
  orderHistory.rows = [];
  orderHistory.promotionColumnMissing = false;
  orderHistory.transientError = false;
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

// ---------------------------------------------------------------------------
// THE MIGRATION, AND WHAT HAPPENS BEFORE IT IS APPLIED
// ---------------------------------------------------------------------------

describe("a missing orders.promotion_id migration never silently unlimits a promotion", () => {
  it("WITHHOLDS a promotion whose total limit cannot be counted", async () => {
    orderHistory.promotionColumnMissing = true;
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 100 })];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    // Not applied — rather than applied as though the cap did not exist.
    expect(quoted.discountAmount).toBe(0);
    expect(quoted.appliedPromotionId).toBeNull();
  });

  it("withholds a promotion whose per-customer limit cannot be counted", async () => {
    orderHistory.promotionColumnMissing = true;
    promotionState.promotions = [promotion("buy-1-get-1-free", { perCustomerLimit: 1 })];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("still runs a promotion that carries no limit at all", async () => {
    // Nothing to count, so nothing to be wrong about. An unmigrated database
    // does not switch the whole promotion system off.
    orderHistory.promotionColumnMissing = true;
    promotionState.promotions = [promotion("buy-1-get-1-free")];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
    expect(quoted.appliedPromotionId).toBe("buy-1-get-1-free");
  });

  it("falls through to an unlimited promotion when the limited one is withheld", async () => {
    orderHistory.promotionColumnMissing = true;
    promotionState.promotions = [
      promotion("buy-1-get-1-free", { maxRedemptions: 100 }),
      promotion("buy-3-get-1-free"),
    ];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.appliedPromotionId).toBe("buy-3-get-1-free");
    expect(quoted.discountAmount).toBe(40);
  });

  it("treats a TRANSIENT count failure differently — the promotion keeps running", async () => {
    // A statement timeout is not a missing migration: it heals, and dropping a
    // promotion the cart already previewed would turn a database blip into a
    // refused sale. Over-running a cap during an incident is the cheaper
    // mistake, and it is logged.
    orderHistory.transientError = true;
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];

    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });
});

describe("what the cart is told matches what the checkout does", () => {
  it("the withheld promotion is absent from the applicable list the cart prices against", async () => {
    orderHistory.promotionColumnMissing = true;
    const { getApplicableBxgyPromotions } = await import("@/lib/bxgy-promotions");
    const applicable = await getApplicableBxgyPromotions({}, {
      promotions: [
        promotion("buy-1-get-1-free", { maxRedemptions: 100 }),
        promotion("buy-3-get-1-free"),
      ],
    });
    // /api/catalog/promotions publishes exactly this list, so the cart cannot
    // preview a promotion the checkout is about to withhold.
    expect(applicable.map((p) => p.id)).toEqual(["buy-3-get-1-free"]);
  });

  it("reports that limits are not enforceable, for the promotion centre", async () => {
    orderHistory.promotionColumnMissing = true;
    const { areUsageLimitsEnforceable } = await import("@/lib/bxgy-promotions");
    expect(await areUsageLimitsEnforceable()).toBe(false);
  });

  it("reports limits ARE enforceable on a migrated database", async () => {
    const { areUsageLimitsEnforceable } = await import("@/lib/bxgy-promotions");
    expect(await areUsageLimitsEnforceable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TAMPERING, AND THE LIMITS OF THE USAGE COUNTER
// ---------------------------------------------------------------------------

describe("a tampered request cannot buy a discount", () => {
  it("ignores any price the client sends — the catalogue is the only price source", async () => {
    // CartItemInput carries an id and a quantity and nothing else, so there is
    // no price field to forge. Asserted on the type's real shape rather than
    // trusted: a `price` added here later would be a live tampering vector.
    const quoted = await quote({
      items: [{ id: "peptide-b", quantity: 4, price: 0.01, unitPrice: 0.01 } as unknown as { id: string; quantity: number }],
    });
    expect(quoted.subtotal).toBe(160); // 4 x $40 from the catalogue, not $0.04
  });

  it("cannot be told which promotion to apply", async () => {
    // The request has no promotion field; the server resolves the applicable
    // list itself. A forged id is simply not read.
    promotionState.promotions = [promotion("buy-2-get-1-free")];
    const quoted = await quote({
      items: [{ id: "peptide-b", quantity: 3 }],
      ...({ promotionId: "buy-1-get-1-free", appliedPromotionId: "buy-1-get-1-free" } as object),
    });
    expect(quoted.appliedPromotionId).toBe("buy-2-get-1-free");
    expect(quoted.discountAmount).toBe(40); // not the 80 a forged BOGO would give
  });

  it("cannot be told a promotion is live when it is not", async () => {
    // Switched off in the control value; nothing in the request can revive it.
    promotionState.promotions = [promotion("buy-1-get-1-free", { enabled: false })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("cannot be told an expired promotion is in date", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { endsAt: "2020-01-01T00:00:00.000Z" })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });

  it("cannot be told a product is eligible when the promotion excludes it", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", {
      eligibility: { includeSlugs: [], excludeSlugs: ["peptide-b"] },
    })];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(0);
  });
});

describe("the usage counter's real limits, stated rather than assumed", () => {
  it("counts each promotion independently, so one cap cannot exhaust another", async () => {
    promotionState.promotions = [
      promotion("buy-1-get-1-free", { maxRedemptions: 1 }),
      promotion("buy-3-get-1-free", { maxRedemptions: 1 }),
    ];
    orderHistory.rows = [paidOrder("buy-1-get-1-free")];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.appliedPromotionId).toBe("buy-3-get-1-free");
  });

  it("TWO SIMULTANEOUS CHECKOUTS CAN BOTH TAKE THE LAST REDEMPTION", async () => {
    // Honest limitation, recorded rather than papered over. The count is read
    // at quote time and the order is written afterwards, with no lock in
    // between, so N concurrent checkouts can overshoot a cap by up to N-1.
    //
    // Bounding it: the window is one checkout, both orders are real sales at a
    // real promotional price, and the overshoot is capped by how many shoppers
    // are inside that window at once. Closing it properly needs the count and
    // the order insert in one transaction (a Postgres function), which is a
    // change to the order-creation path and out of scope here.
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];
    orderHistory.rows = [];

    const [first, second] = await Promise.all([
      quote({ items: [{ id: "peptide-b", quantity: 4 }], email: "racer-one@example.test" }),
      quote({ items: [{ id: "peptide-b", quantity: 4 }], email: "racer-two@example.test" }),
    ]);

    expect(first.appliedPromotionId).toBe("buy-1-get-1-free");
    expect(second.appliedPromotionId).toBe("buy-1-get-1-free");

    // And once either order is on record, the next shopper is correctly refused.
    orderHistory.rows = [paidOrder("buy-1-get-1-free", "racer-one@example.test")];
    const third = await quote({ items: [{ id: "peptide-b", quantity: 4 }], email: "racer-three@example.test" });
    expect(third.appliedPromotionId).toBeNull();
  });

  it("an abandoned or failed checkout does not consume a redemption", async () => {
    promotionState.promotions = [promotion("buy-1-get-1-free", { maxRedemptions: 1 })];
    orderHistory.rows = [
      paidOrder("buy-1-get-1-free", "abandoned@example.test", "pending_payment"),
      paidOrder("buy-1-get-1-free", "failed@example.test", "payment_failed"),
    ];
    const quoted = await quote({ items: [{ id: "peptide-b", quantity: 4 }] });
    expect(quoted.discountAmount).toBe(80);
  });
});
