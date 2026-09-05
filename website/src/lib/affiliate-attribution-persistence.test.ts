import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ORDER RECORD AND THE COMMISSION RECORD, NOT THE CART DISPLAY.
//
// discount-competition-attribution.test.ts pins what the shopper is CHARGED
// when a coupon or a promotion out-saves an ambassador's code. This pins what
// is WRITTEN — because a cart that shows the right total and an order that
// loses the ambassador is the exact failure this whole change is about, and
// only the persisted rows can prove it did not happen.
//
// So both halves run production code against one stateful fake database:
//
//   quoteOrder             -> the real pricing pass, which decides the winner
//   (its output builds the order row exactly as payment-service.ts writes it)
//   processPaymentWebhook  -> the real paid lane, which accrues the commission
//
// and the assertions are on `orders`, `referral_orders` and `commissions`.
//
// The number under the most scrutiny is the commission base. It is
// `orders.subtotal - orders.discount_amount` (accrueCommissionForPaidOrder),
// i.e. the NET merchandise the store actually collected — so a coupon the
// shopper used does reduce the ambassador's commission, and the store never
// pays commission on money it did not take. What a coupon must NOT do is
// remove the ambassador from the order, or push the qualifying subtotal under
// the programme minimum. Both have their own test below.
// ---------------------------------------------------------------------------

const AMB = "amb-persist";
const CODE = "PERSIST";
const ORDER = "order-persist-1";

const CONFIG = {
  /** Her customer discount: 15% of $200 = $30. */
  customerDiscountPercent: 15,
  /** Her commission rate. */
  commissionPercent: 20,
  minimumQualifyingOrder: 1,
};

type Row = Record<string, unknown>;

const db = {
  referralOrders: new Map<string, Row>(),
  commissions: new Map<string, Row>(),
  events: new Map<string, unknown>(),
  paidSideEffectsAt: null as string | null,
  paymentStatus: "pending_payment",
  /** The order row, written from the real quote before the webhook runs. */
  order: null as Row | null,
};

const couponState = vi.hoisted(() => ({ value: 0, code: "SAVE50" }));
const programState = vi.hoisted(() => ({ minimumQualifyingOrder: 1 }));
const ambassadorRow = vi.hoisted(() => ({
  id: "amb-persist",
  name: "Robin Vega",
  email: "robin@ambassadors.test",
  auth_user_id: null as string | null,
  referral_code: "PERSIST",
  commission_percent: 20,
  customer_discount_percent: 15 as number | null,
  status: "approved",
  payout_method: "paypal",
  payout_handle: "robin@ambassadors.test",
}));

// ---------------------------------------------------------------------------
// Everything both halves need, mocked once.
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({ verifyWebhookSignature: () => true }) }));

vi.mock("@/lib/membership", () => ({
  getMembershipPerks: async () => ({
    isActiveMember: false, tierSlug: "free", memberDiscountPercent: 0,
    freeShipping: false, pointsPerDollar: 1, storeCreditBalanceCents: 0, storeCreditMinOrderCents: 0,
  }),
  getPointsBalance: async () => 0,
  isEligibleForBulkSavings: async () => false,
  isPriorityMember: async () => false,
  calculateEarnedPoints: () => 0,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));

const PRODUCTS = {
  "peptide-a": { name: "Peptide A", category: "Research Peptides", price: "$100.00", stockStatus: "In Stock", image: "/a.png", description: "" },
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
    DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
    getBusinessSettings: async () => ({ supportEmail: "support@example.test" }),
    getHomepageControlConfig: async () => ({
      bxgyPromotions: [], bundleStacking: false,
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 0, freeShippingThreshold: 1, internationalFee: 0, internationalFreeShippingThreshold: 1, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({
      enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0,
      defaultCommissionPercent: 10, commissionsPaused: false,
    }),
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

vi.mock("@/lib/ambassador-settings", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ambassador-settings");
  return {
    ...actual,
    getAmbassadorProgramSettings: async () => ({
      minimumQualifyingOrder: programState.minimumQualifyingOrder,
      minimumPayoutThreshold: 25,
      commissionHoldDays: 14,
    }),
    getAmbassadorMarketingResources: async () => [],
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
        freeShipping: false,
      };
    },
    redeemCoupon: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: CONFIG.commissionPercent, tierName: null })),
  detectCommissionFraudSignal: vi.fn(async () => ({ flagged: false, reason: null })),
}));

// Paid-lane side effects, all inert: this file is about what is written to the
// two commission tables, not about email or inventory.
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true, ok: true })) }));
vi.mock("@/lib/email/order-email-once", () => ({ sendOrderEmailOnce: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "commission earned", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "order", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "refund", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: true, finalized: 1, degraded: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ syncOrderToShippo: vi.fn(async () => {}) }));
vi.mock("@/lib/store-credit", () => ({ redeemStoreCredit: vi.fn(async () => {}), refundStoreCreditForOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/membership-billing", () => ({ activatePaidMembership: vi.fn(async () => {}), revokeMembershipForRefund: vi.fn(async () => {}) }));
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));

vi.mock("@/lib/supabase-server", () => {
  /** A commission table with a real UNIQUE(order_id), as production has. */
  function ledger(store: Map<string, Row>) {
    return {
      select: () => {
        const f: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { f[c] = v; return b; },
          in(c: string, v: unknown[]) { f[`in:${c}`] = v; return b; },
          order() { return b; },
          range() { return b; },
          limit() { return b; },
          async maybeSingle() { return { data: store.get(String(f.order_id)) ?? null, error: null }; },
          then(res: (v: unknown) => unknown) {
            const rows = [...store.values()].filter((r) => Object.entries(f).every(([k, v]) => (
              k.startsWith("in:") ? (v as unknown[]).includes(r[k.slice(3)]) : r[k] === v
            )));
            return Promise.resolve(res({ data: rows, error: null }));
          },
        };
        return b;
      },
      insert(row: Row) {
        const key = String(row.order_id);
        const dup = store.has(key);
        if (!dup) store.set(key, { id: `${key}-r`, ...row });
        const env = dup
          ? { data: null, error: { code: "23505", message: "duplicate key" } }
          : { data: { id: `${key}-r` }, error: null };
        const b: Record<string, unknown> = {
          select() { return b; },
          async single() { return env; },
          then(res: (v: unknown) => unknown) { return Promise.resolve(res(env)); },
        };
        return b;
      },
      async upsert(row: Row) {
        const key = String(row.order_id);
        store.set(key, { ...(store.get(key) ?? {}), id: `${key}-r`, ...row });
        return { error: null };
      },
      update(payload: Row) {
        const f: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          eq(c: string, v: unknown) { f[c] = v; return chain; },
          in(c: string, v: unknown[]) { f[`in:${c}`] = v; return chain; },
          select() { return chain; },
          then(res: (v: unknown) => unknown) {
            const hit = [...store.values()].filter((r) => Object.entries(f).every(([k, v]) => (
              k.startsWith("in:") ? (v as unknown[]).includes(r[k.slice(3)]) : r[k] === v
            )));
            for (const r of hit) store.set(String(r.order_id), { ...r, ...payload });
            return Promise.resolve(res({ data: hit, error: null }));
          },
        };
        return chain;
      },
    };
  }

  const emptyChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[m] = () => self;
    }
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 0 }).then(res);
    return self;
  };

  const from = (table: string) => {
    if (table === "ambassadors" || table === "partners") {
      return {
        select: () => ({
          eq: () => ({
            async maybeSingle() { return { data: { ...ambassadorRow }, error: null }; },
            in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }),
          }),
          in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [{ ...ambassadorRow }], error: null })) }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "payment_events") {
      return {
        insert: async (row: Row) => {
          const id = String(row.event_id);
          if (db.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
          db.events.set(id, { processed_at: null, claimed_at: String(row.claimed_at) });
          return { error: null };
        },
        upsert: async () => ({ error: null }),
        select: () => { let id = ""; const b: Record<string, unknown> = { eq(_c: string, v: string) { id = v; return b; }, async maybeSingle() { return { data: db.events.get(id) ?? null, error: null }; } }; return b; },
        update: () => { let id = ""; const b: Record<string, unknown> = { eq(_c: string, v: string) { id = v; return b; }, is() { return b; }, lt() { return b; }, async select() { return db.events.has(id) ? { data: [{ event_id: id }], error: null } : { data: [], error: null }; } }; return b; },
        delete: () => ({ eq: async (_c: string, v: string) => { db.events.delete(v); return { error: null }; } }),
      };
    }
    if (table === "orders") {
      return {
        select: () => { const b: Record<string, unknown> = { eq() { return b; }, limit() { return b; }, order() { return b; }, async maybeSingle() { return { data: db.order, error: null }; } }; return b; },
        update: () => {
          const filters: Array<[string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push([c, v]); return b; },
            neq(c: string, v: unknown) { filters.push([`neq:${c}`, v]); return b; },
            is(c: string, v: unknown) { filters.push([`is:${c}`, v]); return b; },
            select() { return b; },
            then(res: (v: { data: unknown; error: null }) => unknown) { return Promise.resolve(res(settle())); },
          };
          function settle() {
            if (filters.some(([c]) => c === "is:paid_side_effects_at")) {
              if (db.paidSideEffectsAt !== null) return { data: [], error: null };
              db.paidSideEffectsAt = new Date().toISOString();
              return { data: [{ id: "row-1" }], error: null };
            }
            const notPaid = filters.find(([c]) => c === "neq:payment_status");
            if (notPaid) {
              if (db.paymentStatus === notPaid[1]) return { data: [], error: null };
              db.paymentStatus = "paid";
              if (db.order) db.order.payment_status = "paid";
              return { data: [{ id: "row-1" }], error: null };
            }
            return { data: [{ id: "row-1" }], error: null };
          }
          return b;
        },
      };
    }
    if (table === "referral_orders") return ledger(db.referralOrders);
    if (table === "commissions") return ledger(db.commissions);

    const noop: Record<string, unknown> = {
      ...emptyChain(),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }),
      update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
    return noop;
  };

  const client = { from, rpc: async () => ({ data: null, error: null }) };
  return { supabaseAdmin: client, createServerClient: () => client };
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

/**
 * Price a two-vial basket for real, then write the order row from the quote
 * EXACTLY as payment-service.ts does — referral_code and ambassador_id off
 * `quote.referral`, coupon_code off `quote.couponCode`, discount_amount off
 * `quote.discountAmount`. Nothing here is hand-written, so a change to what
 * checkout records changes what this test sees.
 */
async function placeOrder(input: { withReferral?: boolean; withCoupon?: boolean } = {}) {
  const { quoteOrder } = await import("@/lib/quote-order");
  const quote = await quoteOrder({
    items: [{ id: "peptide-a", quantity: 2 }],
    customer: CUSTOMER,
    referralCode: input.withReferral === false ? undefined : CODE,
    couponCode: input.withCoupon ? couponState.code : undefined,
    mode: "full",
  });

  db.order = {
    id: "row-1", order_id: ORDER, order_number: "VL-PER0001", order_type: "product",
    payment_status: db.paymentStatus, fulfillment_status: "pending", payment_method: "card",
    customer_email: CUSTOMER.email, customer_name: CUSTOMER.fullName, customer_user_id: null,
    referral_code: quote.referral?.code ?? null,
    ambassador_id: quote.referral?.ambassadorId ?? null,
    coupon_code: quote.couponCode,
    subtotal: quote.subtotal,
    shipping_amount: quote.shipping,
    discount_amount: quote.discountAmount,
    tax_amount: quote.taxAmount,
    card_processing_fee: 0,
    shipping_protection_fee: 0,
    amount_paid: quote.expectedTotal,
    refund_amount: 0, paid_at: null,
    shipping_address: CUSTOMER.address, city: CUSTOMER.city, postal_code: CUSTOMER.postalCode,
    points_redeemed: 0, store_credit_redeemed_cents: 0,
    membership_tier_id: null, membership_cycle: null,
    inventory_committed_at: null, payment_failure_kind: null,
    order_items: [{ id: 1, product_id: "peptide-a", product_name: "Peptide A", quantity: 2 }],
  };
  return quote;
}

async function pay(eventId = "evt-1") {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  const body = JSON.stringify({ type: "payment.succeeded", data: { object: { metadata: { order_id: ORDER }, amount: 150 } } });
  return processPaymentWebhook(body, "sig", "secret", eventId);
}

const commissionRow = () => db.referralOrders.get(ORDER);
const mirrorRow = () => db.commissions.get(ORDER);

beforeEach(() => {
  vi.resetModules();
  db.referralOrders.clear();
  db.commissions.clear();
  db.events.clear();
  db.paidSideEffectsAt = null;
  db.paymentStatus = "pending_payment";
  db.order = null;
  couponState.value = 0;
  couponState.code = "SAVE50";
  programState.minimumQualifyingOrder = 1;
  ambassadorRow.status = "approved";
  ambassadorRow.customer_discount_percent = CONFIG.customerDiscountPercent;
  vi.clearAllMocks();
});

// ===========================================================================

describe("an order a coupon out-saved still belongs to the ambassador", () => {
  it("writes the ambassador and the code onto the order, next to the coupon", async () => {
    couponState.value = 50; // beats her 15% ($30) on a $200 basket

    const quote = await placeOrder({ withReferral: true, withCoupon: true });

    expect(quote.discountAmount).toBe(50);
    expect(db.order?.subtotal).toBe(200);
    expect(db.order?.discount_amount).toBe(50);
    // Both codes on one order — the state the checkout used to refuse outright.
    expect(db.order?.coupon_code).toBe("SAVE50");
    expect(db.order?.referral_code).toBe(CODE);
    expect(db.order?.ambassador_id).toBe(AMB);
  });

  it("accrues the commission on the NET merchandise the store collected", async () => {
    couponState.value = 50;
    await placeOrder({ withReferral: true, withCoupon: true });

    await pay();

    const row = commissionRow();
    expect(row).toBeDefined();
    expect(row?.ambassador_id).toBe(AMB);
    expect(row?.referral_code).toBe(CODE);
    expect(row?.ineligible_reason).toBeNull();
    // $200 - $50 = $150 commissionable, at her 20% = $30.00. The coupon does
    // reduce her commission, because the store never collected that $50 — but
    // it does not remove her from the order, which is the failure this closes.
    expect(row?.amount_paid).toBe(150);
    expect(row?.commission_percent).toBe(CONFIG.commissionPercent);
    expect(row?.commission_amount).toBe(30);
    // The pre-discount subtotal is kept whole, so what the order qualified on
    // is still on the record.
    expect(row?.original_subtotal).toBe(200);
    expect(row?.customer_discount).toBe(50);
  });

  it("mirrors the same commission into the profit report's table", async () => {
    couponState.value = 50;
    await placeOrder({ withReferral: true, withCoupon: true });

    await pay();

    expect(mirrorRow()?.commission_amount).toBe(30);
    expect(mirrorRow()?.order_id).toBe(ORDER);
  });

  it("pays exactly the same commission whichever code won, for the same net", async () => {
    // Her own code winning: 15% of $200 = $30 off, $170 net, 20% = $34.
    await placeOrder({ withReferral: true });
    await pay("evt-referral-won");
    const whenSheWon = commissionRow()?.commission_amount;

    expect(whenSheWon).toBe(34);
    // And that is 20% of the same `subtotal - discount_amount` rule, so the two
    // lanes differ only by what the shopper was given, never by whose code it
    // was. A $50 coupon leaves $150 net and pays $30 (test above).
    expect(commissionRow()?.amount_paid).toBe(170);
  });
});

describe("a coupon cannot disqualify an order the basket qualified for", () => {
  it("measures the programme minimum against the PRE-discount subtotal", async () => {
    // $200 basket, $175 minimum, and a $50 coupon that drops the net to $150.
    // Measured on the net the order would fall below the minimum and she would
    // be paid nothing on a basket that qualified when it was placed.
    programState.minimumQualifyingOrder = 175;
    couponState.value = 50;

    await placeOrder({ withReferral: true, withCoupon: true });
    await pay();

    const row = commissionRow();
    expect(row?.ineligible_reason).toBeNull();
    expect(row?.original_subtotal).toBe(200);
    expect(row?.commission_amount).toBe(30); // 20% of the $150 net
  });

  it("still records a row, with a reason and no commission, when the basket truly is too small", async () => {
    programState.minimumQualifyingOrder = 500;

    await placeOrder({ withReferral: true });
    await pay();

    const row = commissionRow();
    // The ambassador is on the order either way — a zero row with a reason is
    // an auditable record; a missing row is a lost sale nobody can explain.
    expect(row?.ambassador_id).toBe(AMB);
    expect(row?.commission_amount).toBe(0);
    expect(String(row?.ineligible_reason)).toContain("below the");
  });
});

describe("an order with no referral accrues nothing", () => {
  it("writes no commission row at all", async () => {
    couponState.value = 50;
    await placeOrder({ withReferral: false, withCoupon: true });

    expect(db.order?.ambassador_id).toBeNull();
    await pay();

    expect(commissionRow()).toBeUndefined();
    expect(mirrorRow()).toBeUndefined();
  });
});
