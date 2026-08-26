import { vi } from "vitest";

// ===========================================================================
// ELEVEN GLOBAL MODULE STUBS, AND WHAT EACH ONE HIDES.
//
// Every vi.mock() below applies to ALL 200+ suites. That is deliberate — it
// keeps a pricing test from needing a membership database and stops any suite
// sending a real email — but a global stub is invisible coverage loss: a suite
// that imports the stubbed module without vi.unmock() is testing the stub, and
// nothing says so.
//
// A stub is only safe when the module it replaces is exercised SOMEWHERE. This
// list records where, so the next person can tell "deliberately stubbed" from
// "accidentally untested". Measured by mutation, not assumed.
//
//   @/lib/email/send          Always succeeds, so no suite that relies on this
//                             stub can see a send failure. Suites that need
//                             one replace it per file with a failing double
//                             (order-email-once.test.ts, and journey.harness's
//                             emailFailures counter). Verified: recording a
//                             failed send as "sent" — which would let the
//                             partial unique index block the retry forever —
//                             is caught by order-email-once.test.ts.
//
//   @/lib/membership-billing  Stubbed down to two no-ops, which left
//                             startMembershipSignup — the function that takes
//                             membership money — with ZERO behavioural
//                             coverage. Resolved: membership-signup-behaviour
//                             .test.ts vi.unmock()s it and drives the real
//                             function against the fake database. Before that
//                             file, restoring the historical defect (a FAILED
//                             first charge writing a membership row) left all
//                             3,660 tests green.
//
//   @/lib/coupons             calculateCouponDiscount returns 0. Three fuzz
//                             suites import it without vi.unmock and therefore
//                             assert 0 >= 0 across 40,000+ "cases" — see
//                             docs/findings/BLOCK-E.md. Real coverage lives in
//                             coupons.test.ts / coupon-validation.test.ts.
//
//   @/lib/membership          Perks, points and tiers. Unmocked per file by
//                             the e2e suites and by reconciliation-drift.
//   @/lib/catalog             Two products. Unmocked by the e2e suites.
//   @/lib/admin-control       Store settings. Unmocked by the e2e suites and
//                             overridden per file where real tax/bulk config
//                             matters.
//   @/lib/ambassador-settings Payout threshold + hold days. Overridden per
//                             file by payout-authority.test.ts.
//   @/lib/tax-provider        NOT a stub in the usual sense: it runs the REAL
//                             resolveSalesTax against the mocked settings, so
//                             tax math stays genuine.
//   @/lib/cart-recovery       No-ops. Covered by its own suite.
//   @/lib/supabase-server     A minimal in-memory fake. Almost every suite
//                             that does real database work replaces it per
//                             file with fake-db, the journey harness, or (for
//                             the financial-reporting suites) a real Postgres.
//   @/lib/fulfillment/service A module that DOES NOT EXIST in src. The stub is
//                             inert; nothing imports it. Safe to delete once a
//                             session owns that cleanup.
//
// If you add a stub here, add its line above and say where the real module is
// exercised. If the answer is "nowhere", that is the finding.
// ===========================================================================

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
  // Dynamic sales tax: default mock posture is NO nexus states (matches the
  // production default — no tax collected until the admin configures states).
  getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
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

// tax-provider imports "server-only" (fails to load under vitest) — mock it
// with the REAL shared resolver running against the mocked admin settings, so
// payment-service tests exercise genuine tax math (no nexus → $0 by default).
vi.mock("@/lib/tax-provider", async () => {
  const { resolveSalesTax } = await vi.importActual<typeof import("@/lib/sales-tax")>("@/lib/sales-tax");
  const { getSalesTaxSettings } = await import("@/lib/admin-control");
  return {
    quoteSalesTax: async (request: {
      taxableAmount: number; shippingAmount: number;
      country?: string | null; state?: string | null; city?: string | null;
      postalCode?: string | null; street?: string | null;
    }) => {
      const settings = await getSalesTaxSettings();
      const quote = resolveSalesTax({
        ...request,
        config: { nexusStates: settings.nexusStates, rateOverrides: settings.rateOverrides },
      });
      return { ...quote, settings };
    },
  };
});

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
      // Note the ABSENCE of inventoryQuantity: the real catalog reads no longer
      // publish it, because these objects are serialized to client components.
      // The checkout oversell guard reads getStockLevelsBySlugs instead.
    })),
  // Empty map = no stock on record, which makes the secondary oversell guard a
  // no-op. That is the correct default here: these suites test pricing, and the
  // authoritative gate is the atomic reservation, not this guard.
  getStockLevelsBySlugs: async () => new Map<string, number>(),
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

  // Exposed so a suite can seed a pre-existing row and then assert what a
  // webhook did to it. Without this the mock is write-only from a test's point
  // of view, which is how a webhook that NULLED a real order's customer email
  // sat here undetected: every existing test asserted the returned status, and
  // none could look at the row afterwards.
  (globalThis as Record<string, unknown>).__vlSupabaseState = state;

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
