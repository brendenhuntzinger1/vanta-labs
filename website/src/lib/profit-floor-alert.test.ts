import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// THE PROFIT FLOOR INFORMS THE OWNER. IT DOES NOT REFUSE THE CUSTOMER.
//
// quoteOrder used to THROW "Promotion unavailable on this order." whenever a
// basket priced below the configured floor. That is a customer-facing refusal
// of a real sale, decided by numbers the shopper cannot see and cannot act on —
// and it named a promotion that was usually not the cause. On this store's own
// catalogue it refused 8 of 24 ordinary affiliate baskets, including a single
// GHRP-2 vial, and it did so SILENTLY: no alert, no counter, nothing. Sales
// were being lost with no record that they had ever been attempted.
//
// The owner's rule, which these tests pin:
//
//   * never reject an otherwise valid order because of the profit floor;
//   * the customer always gets the best valid discount available;
//   * a below-floor order COMPLETES, and raises an internal alert instead;
//   * the alert carries what the owner needs to understand what happened;
//   * the shopper is never told anything about margin, COGS or commission.
//
// The floor settings are unchanged and still admin-configurable — their PURPOSE
// changed, from a blocking threshold to an alerting one.
// ---------------------------------------------------------------------------

const alerts = vi.hoisted(() => [] as Array<{ type: string; severity: string; message: string; context: Record<string, unknown> }>);

const ambassador = vi.hoisted(() => ({
  id: "amb-floor",
  name: "Robin Vega",
  email: "robin@ambassadors.test",
  auth_user_id: null as string | null,
  referral_code: "ROBIN15",
  commission_percent: 20,
  customer_discount_percent: 15 as number | null,
  status: "approved",
}));

const promotionState = vi.hoisted(() => ({ promotions: [] as BxgyPromotion[], allowCouponStacking: false }));
const couponState = vi.hoisted(() => ({ value: 0, code: "SAVE" }));
/** Production has every profit key blank, so these are the coded defaults. */
const profitState = vi.hoisted(() => ({
  minProfitDollars: 0, minProfitPercent: 0, worstCaseUnitCost: 33,
  processingFeePercent: 8, shippingCostPerOrder: 6,
}));

vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (a: { type: string; severity: string; message: string; context?: Record<string, unknown> }) => {
    alerts.push({ type: a.type, severity: a.severity, message: a.message, context: a.context ?? {} });
  }),
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

vi.mock("@/lib/supabase-server", () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) self[m] = () => self;
    self.maybeSingle = async () => result;
    self.single = async () => result;
    self.then = (r: (v: unknown) => unknown) => Promise.resolve({ ...result, count: 0 }).then(r);
    return self;
  };
  const client = {
    from: (t: string) => (t === "ambassadors" ? chain({ data: { ...ambassador }, error: null }) : chain({ data: null, error: null })),
    rpc: async () => ({ data: null, error: null }),
  };
  return { supabaseAdmin: client, createServerClient: () => client };
});

// GHRP-2 is the real catalogue's thinnest margin: $39.99 against a $33.00 cost.
// It is the product the old guard refused at a single unit.
const PRODUCTS = {
  "ghrp-2": { name: "GHRP-2", category: "Research Peptides", price: "$39.99", stockStatus: "In Stock", image: "/g.png", description: "" },
  "klow": { name: "KLOW", category: "Research Peptides", price: "$119.99", stockStatus: "In Stock", image: "/k.png", description: "" },
} as const;

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((s) => s in PRODUCTS).map((s) => ({ ...PRODUCTS[s as keyof typeof PRODUCTS], slug: s })),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
}));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: promotionState.promotions, bundleStacking: false,
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 15, freeShippingThreshold: 200, internationalFee: 25, internationalFreeShippingThreshold: 400, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: promotionState.allowCouponStacking }),
    getProfitSettings: async () => ({
      minProfitPercent: profitState.minProfitPercent,
      minProfitDollars: profitState.minProfitDollars,
      worstCaseUnitCost: profitState.worstCaseUnitCost,
      processingFeePercent: profitState.processingFeePercent,
      processingFeeIncludesTax: false,
      countSalesTaxAsProfit: false,
      shippingCostPerOrder: profitState.shippingCostPerOrder,
    }),
    getPaymentMethodsConfig: async () => ([
      { id: "card", label: "Credit / Debit Card", kind: "card", enabled: true, order: 100, icon: "", recommended: false, badges: [], instructions: [] },
    ]),
  };
});

vi.mock("@/lib/ambassador-settings", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ambassador-settings");
  return {
    ...actual,
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, minimumPayoutThreshold: 25, commissionHoldDays: 14 }),
  };
});

vi.mock("@/lib/coupons", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/coupons");
  return {
    ...actual,
    validateCoupon: async (code: string | undefined, subtotal: number) => (code && couponState.value > 0
      ? { code: couponState.code, discountType: "fixed" as const, discountValue: couponState.value, discountAmount: Math.min(couponState.value, subtotal), freeShipping: false }
      : null),
  };
});

const CUSTOMER = {
  email: "shopper@example.test", fullName: "Test Shopper", address: "1 Test Street",
  city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100",
};

function promotion(id: string, overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  const found = defaultBxgyPromotions().find((e) => e.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true, ...overrides };
}

async function quote(input: { items: Array<{ id: string; quantity: number }>; withReferral?: boolean; withCoupon?: boolean }) {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    items: input.items,
    customer: CUSTOMER,
    referralCode: input.withReferral ? "ROBIN15" : undefined,
    couponCode: input.withCoupon ? couponState.code : undefined,
    mode: "full",
  });
}

beforeEach(() => {
  vi.resetModules();
  alerts.length = 0;
  ambassador.customer_discount_percent = 15;
  ambassador.commission_percent = 20;
  promotionState.promotions = [];
  promotionState.allowCouponStacking = false;
  couponState.value = 0;
  profitState.minProfitDollars = 0;
  profitState.minProfitPercent = 0;
  profitState.processingFeePercent = 8;
  profitState.shippingCostPerOrder = 6;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. NO ORDER IS EVER REFUSED FOR MARGIN
// ===========================================================================

describe("a below-floor order completes", () => {
  it("prices a NEGATIVE-margin basket instead of refusing it", async () => {
    // 2 x GHRP-2 = $79.98 against $66.00 of goods, less a 15% referral, plus
    // 20% commission and an 8% processing assumption: about -$9 of profit.
    // The old guard threw here.
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true });

    expect(quoted.subtotal).toBe(79.98);
    expect(quoted.expectedTotal).toBeGreaterThan(0);
    expect(quoted.profitFloor?.belowFloor).toBe(true);
    expect(quoted.profitFloor?.estimatedProfit).toBeLessThan(0);
  });

  it("prices a basket that is only SLIGHTLY below the floor", async () => {
    // One GHRP-2 with the same ambassador lands a few cents under break-even.
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 1 }], withReferral: true });

    expect(quoted.expectedTotal).toBeGreaterThan(0);
    expect(quoted.profitFloor?.belowFloor).toBe(true);
    expect(quoted.profitFloor?.estimatedProfit).toBeLessThan(0);
    expect(quoted.profitFloor?.estimatedProfit).toBeGreaterThan(-5);
  });

  it("never throws for margin, at any depth of loss", async () => {
    // A deliberately absurd loss: a huge coupon on the thinnest product.
    couponState.value = 70;
    await expect(quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true, withCoupon: true }))
      .resolves.toBeDefined();
  });

  it("leaves a HEALTHY order alone, with nothing to report", async () => {
    const quoted = await quote({ items: [{ id: "klow", quantity: 2 }], withReferral: true });

    expect(quoted.profitFloor?.belowFloor).toBe(false);
    expect(quoted.profitFloor?.estimatedProfit).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. THE SHOPPER IS TOLD NOTHING ABOUT MARGIN
// ===========================================================================

describe("nothing customer-facing mentions margin", () => {
  it("produces no profit-floor error text on a loss-making order", async () => {
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true });
    const shopperVisible = JSON.stringify({
      discountLabel: quoted.discountLabel,
      appliedPromotionName: quoted.appliedPromotionName,
      lineItems: quoted.lineItems,
      expectedTotal: quoted.expectedTotal,
    });

    for (const word of ["Promotion unavailable", "profit", "margin", "COGS", "commission", "cost"]) {
      expect(shopperVisible.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("keeps the floor numbers out of the quote's customer-facing fields", async () => {
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true });
    // The snapshot exists for the SERVER to alert with. It must not be reachable
    // from anything the checkout renders — the totals the shopper sees are the
    // ones already asserted above, and none of them carry it.
    expect(quoted.profitFloor).toBeDefined();
    expect(quoted.discountLabel).not.toContain("profit");
  });
});

// ===========================================================================
// 3. PRICING IS UNCHANGED — the floor decides nothing about the deal
// ===========================================================================

describe("the discount contest is unaffected by the floor", () => {
  it("still gives the best single discount on a loss-making basket", async () => {
    // Referral 15% of $79.98 = $12.00 against a $20 coupon: the coupon wins,
    // exactly as it would on a profitable basket.
    couponState.value = 20;
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.discountAmount).toBe(20);
    expect(quoted.discountLabel).toBe("Coupon");
    expect(quoted.profitFloor?.belowFloor).toBe(true);
  });

  it("keeps affiliate attribution on a loss-making order", async () => {
    couponState.value = 20;
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true, withCoupon: true });

    expect(quoted.referral?.code).toBe("ROBIN15");
    expect(quoted.referral?.ambassadorId).toBe("amb-floor");
  });

  it("still stacks only where configured, even below the floor", async () => {
    promotionState.allowCouponStacking = true;
    couponState.value = 20;
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true, withCoupon: true });

    // 15% referral ($12.00) + the $20 coupon, because the admin switch says so.
    expect(quoted.discountAmount).toBe(32);
    expect(quoted.profitFloor?.belowFloor).toBe(true);
  });

  it("still records a limited promotion only when it actually priced the order", async () => {
    // The promotion is worth $39.99 (one free unit of four); a 15% referral on
    // $159.96 is $24.00, so the promotion wins and IS recorded.
    promotionState.promotions = [promotion("buy-3-get-1-free")];
    const won = await quote({ items: [{ id: "ghrp-2", quantity: 4 }], withReferral: true });
    expect(won.appliedPromotionId).toBe("buy-3-get-1-free");

    // Raise the ambassador above it and the promotion takes nothing off, so it
    // must not be written to the order and must not consume a redemption.
    ambassador.customer_discount_percent = 40;
    const lost = await quote({ items: [{ id: "ghrp-2", quantity: 4 }], withReferral: true });
    expect(lost.appliedPromotionId).toBeNull();
    expect(lost.profitFloor?.belowFloor).toBe(true);
  });
});

// ===========================================================================
// 4. THE ALERT, AND WHAT IT HAS TO CARRY
// ===========================================================================

describe("the alert the owner gets", () => {
  async function insertBelowFloorOrder() {
    const quoted = await quote({ items: [{ id: "ghrp-2", quantity: 2 }], withReferral: true });
    const { alertIfBelowProfitFloor } = await import("@/lib/profit-floor-alert");
    await alertIfBelowProfitFloor("order-floor-1", quoted.profitFloor ?? null);
    return quoted;
  }

  it("fires when the configured threshold is crossed", async () => {
    await insertBelowFloorOrder();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("order_below_profit_floor");
  });

  it("carries everything needed to understand what happened", async () => {
    const quoted = await insertBelowFloorOrder();
    const ctx = alerts[0].context;

    expect(ctx.orderId).toBe("order-floor-1");
    expect(ctx.subtotal).toBe(quoted.subtotal);
    expect(ctx.discountAmount).toBe(quoted.discountAmount);
    expect(ctx.discountLabel).toBe(quoted.discountLabel);
    expect(ctx.commission).toBeGreaterThan(0);
    expect(ctx.processingFee).toBeGreaterThan(0);
    expect(ctx.productCost).toBeGreaterThan(0);
    expect(ctx.shippingCollected).toBeDefined();
    expect(ctx.shippingCost).toBeDefined();
    expect(ctx.estimatedProfit).toBeLessThan(0);
    expect(ctx.thresholdDollars).toBe(0);
    expect(ctx.thresholdPercent).toBe(0);
  });

  it("says nothing at all on a healthy order", async () => {
    const quoted = await quote({ items: [{ id: "klow", quantity: 2 }], withReferral: true });
    const { alertIfBelowProfitFloor } = await import("@/lib/profit-floor-alert");
    await alertIfBelowProfitFloor("order-healthy-1", quoted.profitFloor ?? null);

    expect(alerts).toHaveLength(0);
  });

  it("follows the configured threshold, not a hardcoded zero", async () => {
    // A profitable order the owner nonetheless wants to hear about: KLOW x2
    // earns well over $25, so raising the floor to $500 must alert on it.
    profitState.minProfitDollars = 500;
    const quoted = await quote({ items: [{ id: "klow", quantity: 2 }], withReferral: true });
    const { alertIfBelowProfitFloor } = await import("@/lib/profit-floor-alert");
    await alertIfBelowProfitFloor("order-threshold-1", quoted.profitFloor ?? null);

    expect(quoted.profitFloor?.estimatedProfit).toBeGreaterThan(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].context.thresholdDollars).toBe(500);
  });

  it("is a no-op when there is no snapshot to report", async () => {
    const { alertIfBelowProfitFloor } = await import("@/lib/profit-floor-alert");
    await alertIfBelowProfitFloor("order-none", null);
    expect(alerts).toHaveLength(0);
  });
});
