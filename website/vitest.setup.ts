import { vi } from "vitest";

type GenericRow = Record<string, unknown>;

vi.mock("@/lib/email/send", () => ({
  sendEmail: async () => ({ success: true }),
}));

vi.mock("@/lib/coupons", () => ({
  normalizeCouponCode: (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, ""),
  calculateCouponDiscount: () => 0,
  validateCoupon: async () => null,
  redeemCoupon: async () => {},
}));

vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 0,
  dollarsToPoints: () => 0,
  pointsToDollars: () => 0,
  POINTS_PER_DOLLAR_REDEMPTION: 100,
  getActiveMembershipTiers: async () => [],
  getFreeTier: async () => null,
  getCustomerMembership: async () => ({
    tier: { id: "free", slug: "free", name: "Research Member", monthlyPriceCents: 0, annualPriceCents: 0, pointsPerDollar: 2, freeShipping: false, priorityShipping: false, earlyAccess: false, exclusivePricing: false, referralBonusPoints: 0, benefits: [], position: 0, isActive: true },
    billingCycle: "free",
    status: "active",
    startedAt: new Date().toISOString(),
    renewsAt: null,
  }),
  getActivePointsMultiplier: async () => ({ multiplier: 1, eventName: null }),
  getPointsBalance: async () => 0,
  getPointsHistory: async () => [],
  recordPointsLedgerEntry: async () => {},
  reverseOrderPoints: async () => {},
  getReferralEarnedPoints: async () => 0,
  getProgressToNextReward: () => ({ pointsIntoMilestone: 0, milestone: 500, nextMilestone: 500, progressPercent: 0 }),
  getMembershipBonusSettings: async () => ({
    signupBonusEnabled: true,
    referralBonusEnabled: true,
    birthdayBonusEnabled: true,
    signupBonusPoints: 200,
    referralSignupBonusPoints: 100,
    birthdayBonusPoints: 150,
  }),
  awardSignupBonusIfNeeded: async () => {},
  awardReferralSignupBonus: async () => {},
  checkAndAwardBirthdayBonus: async () => false,
  isEligibleForBulkSavings: async () => false,
  isPriorityMember: async () => false,
  getTierBySlug: async () => null,
}));

vi.mock("@/lib/cart-recovery", () => ({
  markAbandonedCartsRecovered: async () => {},
  trackCart: async () => {},
  getAbandonedCartById: async () => null,
  mintCartRecoveryCoupon: async () => null,
  runAbandonedCartSweep: async () => ({ t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0 }),
}));

vi.mock("@/lib/admin-control", () => ({
  getHomepageControlConfig: async () => ({ promoBuy3Get1Enabled: false }),
  getBulkSavingsControlConfig: async () => ({
    enabled: true,
    tier1Threshold: 500,
    tier1Percent: 5,
    tier2Threshold: 1000,
    tier2Percent: 12,
  }),
  getTaxRatePercent: async () => 0,
  getShippingConfig: async () => ({
    domesticFee: 15,
    freeShippingThreshold: 250,
    internationalFee: 60,
    internationalFreeShippingThreshold: 600,
    handlingFeeRate: 0.05,
  }),
  getCardProcessingFeeConfig: async () => ({ enabled: true, percentage: 5, label: "Card Processing Fee", noticeText: "" }),
  getReferralProgramConfig: async () => ({
    enabled: true,
    discountPercent: 10,
    bundleReferralPercent: 5,
    personalDiscountPercent: 10,
    defaultCommissionPercent: 10,
    commissionsPaused: false,
  }),
  getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: false }),
  getProfitSettings: async () => ({ minProfitPercent: 0, minProfitDollars: 0, worstCaseUnitCost: 33, processingFeePercent: 10 }),
  getPaymentMethodsConfig: async () => ([
    { id: "card", label: "Credit / Debit Card", kind: "card", enabled: true, order: 100, icon: "", recommended: false, badges: [], instructions: [] },
    { id: "cashapp", label: "Cash App", kind: "manual", enabled: true, order: 10, icon: "", recommended: true, badges: [], instructions: [] },
  ]),
}));

vi.mock("@/lib/membership-billing", () => ({
  activateAnnualMembership: async () => {},
  createAnnualMembershipManualOrder: async () => ({ orderId: "order-x", orderNumber: "VL-TEST", amount: 0 }),
}));

vi.mock("@/lib/fulfillment/service", () => ({
  transmitOrderToFulfillment: async () => {},
  computePayoutOwed: () => 0,
  countUnits: () => 0,
  applyInboundFulfillmentEvent: async () => ({ ok: true, message: "" }),
}));

vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 100,
    minimumPayoutThreshold: 100,
    commissionHoldDays: 14,
  }),
  setAmbassadorProgramSetting: async () => {},
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => slugs
    .filter((slug) => slug === "bpc-157-10mg")
    .map((slug) => ({
      slug,
      name: "BPC-157",
      category: "Research Peptides",
      price: "$44.99",
      stockStatus: "In Stock",
      batchNumber: "VL-0718A",
      purityResult: "99.8%",
      description: "Synthetic pentadecapeptide.",
      image: "/images/vantalabs.png",
      testingDate: "2026-07-10",
      labName: "Vanta Independent Testing Group",
      coaUrl: "/demo-coa.pdf",
      molecularFormula: "C62H98N16O22",
    })),
}));

vi.mock("@/lib/supabase-server", () => {
  const state = {
    paymentEvents: new Map<string, { event_id: string; processed_at: unknown; claimed_at: unknown }>(),
    orders: new Map<string, { id: string; order_id: string; payment_status?: unknown; paid_at?: unknown }>(),
    referralOrders: new Map<string, { id: string; order_id: string; payment_status?: unknown }>(),
    ambassadors: new Map<string, { id: string; name: string; referral_code: string; commission_percent: number; status: string }>(),
    products: [
      {
        slug: "bpc-157-10mg",
        name: "BPC-157",
        category: "Research Peptides",
        price_cents: 4499,
        stock_status: "In Stock",
        batch_number: "VL-0718A",
        purity_result: "99.8%",
        description: "Synthetic pentadecapeptide.",
        image_url: "/images/vantalabs.png",
        testing_date: "2026-07-10",
        lab_name: "Vanta Independent Testing Group",
        coa_url: "/demo-coa.pdf",
        molecular_formula: "C62H98N16O22",
        is_active: true,
      },
    ],
  };

  function maybeSingleFor(table: string, filterCol?: string, filterValue?: string | boolean) {
    if (table === "products") {
      if (filterCol === "slug") {
        return state.products.find((row) => row.slug === String(filterValue)) ?? null;
      }
      return state.products[0] ?? null;
    }

    if (table === "payment_events" && filterCol === "event_id") {
      return state.paymentEvents.get(String(filterValue)) ?? null;
    }

    if (table === "orders" && filterCol === "order_id") {
      return state.orders.get(String(filterValue)) ?? null;
    }

    if (table === "referral_orders" && filterCol === "order_id") {
      return state.referralOrders.get(String(filterValue)) ?? null;
    }

    if (table === "ambassadors" && filterCol === "referral_code") {
      return state.ambassadors.get(String(filterValue)) ?? null;
    }

    return null;
  }

  function makeSelectChain(table: string) {
    let filterCol: string | undefined;
    let filterValue: string | boolean | undefined;
    let inFilterCol: string | undefined;
    let inFilterValues: string[] | undefined;

    const getRows = () => {
      if (table === "products") {
        let rows = [...state.products];
        const slugFilterValues = inFilterValues;
        if (inFilterCol === "slug" && slugFilterValues) {
          rows = rows.filter((row) => slugFilterValues.includes(row.slug));
        }
        if (filterCol === "slug") {
          rows = rows.filter((row) => row.slug === String(filterValue));
        }
        if (filterCol === "is_active") {
          rows = rows.filter((row) => row.is_active === filterValue);
        }
        return rows;
      }

      const maybeSingle = maybeSingleFor(table, filterCol, filterValue);
      return maybeSingle ? [maybeSingle] : [];
    };

    const chain = {
      eq: (col: string, value: string | boolean) => {
        filterCol = col;
        filterValue = value;
        return chain;
      },
      in: (col: string, values: string[]) => {
        inFilterCol = col;
        inFilterValues = values;
        return chain;
      },
      order: async () => ({ data: getRows(), error: null }),
      maybeSingle: async () => ({ data: getRows()[0] ?? null, error: null }),
      single: async () => ({ data: getRows()[0] ?? { id: "mock-id" }, error: null }),
      limit: async () => ({ data: getRows(), error: null }),
    };

    return chain;
  }

  function makeTableClient(table: string) {
    return {
      select: () => makeSelectChain(table),
      insert: (payload: GenericRow | GenericRow[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];

        // Simulate the payment_events primary-key uniqueness so the atomic
        // claim-based webhook idempotency (insert -> 23505 on duplicate) can be
        // exercised in tests.
        if (table === "payment_events") {
          for (const row of rows) {
            const id = String(row?.event_id ?? "");
            if (id && state.paymentEvents.has(id)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
          }
          for (const row of rows) {
            if (row?.event_id) {
              state.paymentEvents.set(String(row.event_id), {
                event_id: String(row.event_id),
                processed_at: row.processed_at ?? null,
                claimed_at: row.claimed_at ?? new Date().toISOString(),
              });
            }
          }
          return { data: null, error: null };
        }

        if (table === "orders") {
          for (const row of rows) {
            const orderId = String(row.order_id ?? "mock-order");
            state.orders.set(orderId, { id: `order-${orderId}`, order_id: orderId, payment_status: row.payment_status, paid_at: row.paid_at ?? null });
          }
        }

        if (table === "referral_orders") {
          for (const row of rows) {
            const orderId = String(row.order_id ?? "mock-order");
            state.referralOrders.set(orderId, { id: `ref-${orderId}`, order_id: orderId, payment_status: row.payment_status });
          }
        }

        return {
          data: null,
          error: null,
          select: () => ({
            single: async () => ({ data: { id: "mock-id" }, error: null }),
          }),
        };
      },
      update: (payload: GenericRow) => {
        const filters: Record<string, string> = {};
        const apply = () => {
          if (table === "orders" && filters.order_id !== undefined) {
            const existing = state.orders.get(filters.order_id) ?? { id: `order-${filters.order_id}`, order_id: filters.order_id };
            state.orders.set(filters.order_id, { ...existing, ...payload });
            return { data: [{ id: existing.id, order_id: filters.order_id }], error: null };
          }
          if (table === "referral_orders" && filters.order_id !== undefined) {
            const existing = state.referralOrders.get(filters.order_id) ?? { id: `ref-${filters.order_id}`, order_id: filters.order_id };
            state.referralOrders.set(filters.order_id, { ...existing, ...payload });
            return { data: [{ id: existing.id }], error: null };
          }
          if (table === "payment_events" && filters.event_id !== undefined) {
            const existing = state.paymentEvents.get(filters.event_id);
            if (existing) {
              state.paymentEvents.set(filters.event_id, { ...existing, ...(payload as object) });
            }
            return { data: existing ? [{ event_id: filters.event_id }] : [], error: null };
          }
          return { data: [], error: null };
        };
        // Chainable, awaitable builder supporting eq/neq/is/lt/gt + terminal select().
        const builder: Record<string, unknown> = {
          eq: (col: string, value: string) => { filters[col] = String(value); return builder; },
          neq: () => builder,
          is: () => builder,
          lt: () => builder,
          gt: () => builder,
          select: () => apply(),
          then: (resolve: (v: unknown) => unknown) => resolve(apply()),
        };
        return builder;
      },
      delete: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
      upsert: async (payload: GenericRow | GenericRow[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];

        if (table === "payment_events") {
          for (const row of rows) {
            if (row?.event_id) {
              const id = String(row.event_id);
              const existing = state.paymentEvents.get(id);
              state.paymentEvents.set(id, {
                event_id: id,
                processed_at: row.processed_at ?? existing?.processed_at ?? new Date().toISOString(),
                claimed_at: existing?.claimed_at ?? new Date().toISOString(),
              });
            }
          }
        }

        return { data: null, error: null };
      },
    };
  }

  const mockClient = {
    from: (table: string) => makeTableClient(table),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      admin: {
        inviteUserByEmail: async () => ({ data: null, error: null }),
      },
    },
  };

  return {
    createServerClient: () => mockClient,
    supabaseAdmin: mockClient,
  };
});
