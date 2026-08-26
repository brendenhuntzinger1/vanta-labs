import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// HAS THE FOURTH COPY OF THE TOTAL FORMULA DRIFTED?
//
// `orders.amount_paid` is computed in exactly one place — quote-order.ts:
//
//   totalBeforePoints = subtotal + shipping + tax − discount
//   totalAfterCredit  = max(0, totalBeforePoints − storeCredit)
//   expectedTotal     = max(0, totalAfterCredit − points) + shippingProtection
//   finalTotal        = expectedTotal + cardFee            <- written to amount_paid
//
// `reconciliation-math.expectedOrderTotal` re-derives that same number from the
// stored columns, by hand, in one expression. It is the FOURTH hand-written copy
// of this formula in the codebase, and it is the one that decides whether the
// operator's reconciliation screen accuses an order of not adding up.
//
// Nothing compared the two. `reconciliation-math.test.ts` is sound but tests the
// copy against hand-computed values — it would pass unchanged if quoteOrder's
// formula moved underneath it, which is exactly how a fourth copy drifts.
//
// So this suite runs the REAL quoteOrder, hands its result to the REAL
// buildOrderRow, and reconciles the REAL row. No formula is restated here; if
// the two disagree by a cent on any input, one of these fails. That is the only
// arrangement that can answer the question.
// ---------------------------------------------------------------------------

/**
 * Store credit, points and the bulk discount are only reachable for a signed-in
 * member, so the sweep would otherwise leave three of the formula's seven terms
 * at zero — and a term that is always zero cannot disagree. (It did: flipping
 * the sign of `- c.discount` in reconciliation-math left all ten tests green
 * until these were added.)
 */
const member = vi.hoisted(() => ({
  storeCreditBalanceCents: 0,
  storeCreditMinOrderCents: 0,
  pointsBalance: 0,
  bulkEligible: false,
  memberDiscountPercent: 0,
}));

vi.mock("@/lib/membership", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/membership");
  return {
    ...actual,
    getMembershipPerks: async () => ({
      isActiveMember: true, tierSlug: "pro",
      memberDiscountPercent: member.memberDiscountPercent,
      freeShipping: false, pointsPerDollar: 1,
      storeCreditBalanceCents: member.storeCreditBalanceCents,
      storeCreditMinOrderCents: member.storeCreditMinOrderCents,
    }),
    getPointsBalance: async () => member.pointsBalance,
    isEligibleForBulkSavings: async () => member.bulkEligible,
    isPriorityMember: async () => false,
  };
});

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs
      .filter((slug) => slug in PRODUCTS)
      .map((slug) => ({ ...PRODUCTS[slug as keyof typeof PRODUCTS], slug })),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
}));

// Real sales tax, on a real nexus state, so the tax term is exercised rather
// than defaulted to zero the way the global setup mock leaves it.
vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({ promoBuy3Get1Enabled: false }),
    getBulkSavingsControlConfig: async () => ({ enabled: true, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    getSalesTaxSettings: async () => ({ nexusStates: ["PA"], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 15, freeShippingThreshold: 250, internationalFee: 60, internationalFreeShippingThreshold: 600, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: true, percentage: 5, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 10, defaultCommissionPercent: 10, commissionsPaused: false }),
    getCouponPolicyConfig: async () => ({ couponsEnabled: true, allowStacking: false }),
    getProfitSettings: async () => ({
      minProfitPercent: 0, minProfitDollars: -1e9, worstCaseUnitCost: 0,
      processingFeePercent: 0, processingFeeIncludesTax: true,
      countSalesTaxAsProfit: false, shippingCostPerOrder: 0,
    }),
    getPaymentMethodsConfig: async () => ([
      { id: "card", label: "Credit / Debit Card", kind: "card", enabled: true, order: 100, icon: "", recommended: false, badges: [], instructions: [] },
      { id: "zelle", label: "Zelle", kind: "manual", enabled: true, order: 10, icon: "", recommended: false, badges: [], instructions: [] },
    ]),
  };
});

const PRODUCTS = {
  "peptide-a": { name: "Peptide A", category: "Research Peptides", price: "$44.99", stockStatus: "In Stock", image: "/x.png", description: "" },
  "peptide-b": { name: "Peptide B", category: "Research Peptides", price: "$129.00", stockStatus: "In Stock", image: "/x.png", description: "" },
  "peptide-c": { name: "Peptide C", category: "Research Peptides", price: "$7.25", stockStatus: "In Stock", image: "/x.png", description: "" },
} as const;

const CUSTOMER = {
  email: "buyer@example.test",
  fullName: "Test Buyer",
  address: "1 Test Street",
  city: "Philadelphia",
  state: "PA",
  postalCode: "19103",
  country: "US",
  phone: "2155550100",
};

/**
 * Drives the real pricing pass and the real row builder, then reconciles the
 * row exactly the way admin-reconciliation.getReconciliationFlags does —
 * including its `points_redeemed / 100` and `store_credit_redeemed_cents / 100`
 * unit conversions, which are themselves part of the copy under test.
 */
async function quoteAndReconcile(input: {
  items: Array<{ slug: string; quantity: number }>;
  shippingProtection?: boolean;
  paymentMethod?: string;
  storeCreditCents?: number;
  pointsToRedeem?: number;
  bulkEligible?: boolean;
  memberDiscountPercent?: number;
}) {
  member.storeCreditBalanceCents = input.storeCreditCents ?? 0;
  member.storeCreditMinOrderCents = 0;
  member.pointsBalance = input.pointsToRedeem ?? 0;
  member.bulkEligible = input.bulkEligible === true;
  member.memberDiscountPercent = input.memberDiscountPercent ?? 0;
  const signedIn = Boolean(
    input.storeCreditCents || input.pointsToRedeem || input.bulkEligible || input.memberDiscountPercent,
  );
  const { quoteOrder, buildOrderRow } = await import("@/lib/quote-order");
  const { expectedOrderTotal, isTotalMismatch } = await import("@/lib/reconciliation-math");

  const quote = await quoteOrder({
    items: input.items.map((i) => ({ id: i.slug, quantity: i.quantity })),
    customer: CUSTOMER,
    shippingProtection: input.shippingProtection,
    paymentMethod: input.paymentMethod ?? "card",
    customerUserId: signedIn ? "user-test" : undefined,
    pointsToRedeem: input.pointsToRedeem,
    mode: "full",
  });

  // The same mapping payment-service.createCheckoutSession performs. Only field
  // routing — every number comes from the quote, so no formula is restated.
  const draft = buildOrderRow({
    orderId: "order-test", orderNumber: "VL-TEST", idempotencyKey: null, paymentId: null,
    paymentMethod: quote.selectedMethod.id,
    cardProcessingFee: quote.cardFee.amount,
    cardProcessingFeePercent: quote.cardFee.percentage,
    customer: CUSTOMER, currency: "USD",
    subtotal: quote.subtotal,
    shippingAmount: quote.shipping,
    taxAmount: quote.taxAmount,
    discountAmount: quote.discountAmount,
    shippingProtectionFee: quote.shippingProtectionFee,
    bulkDiscountTier: quote.bulkDiscountTier,
    priority: quote.isPriorityOrder,
    amountPaid: quote.finalTotal,
    referralCode: null, ambassadorId: null, couponCode: null, customerUserId: null,
    pointsRedeemed: quote.pointsRedeemed,
    storeCreditRedeemedCents: quote.storeCreditRedeemedCents,
    taxRatePercent: quote.taxQuote.collected ? quote.taxQuote.ratePercent : 0,
    taxState: quote.taxQuote.collected ? quote.taxQuote.state : null,
  });

  const row = draft.full as Record<string, number | null>;
  const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

  const expected = expectedOrderTotal({
    subtotal: money(row.subtotal),
    shipping: money(row.shipping_amount),
    tax: money(row.tax_amount),
    cardFee: money(row.card_processing_fee),
    discount: money(row.discount_amount),
    storeCredit: money(Number(row.store_credit_redeemed_cents ?? 0) / 100),
    pointsDollars: money(Number(row.points_redeemed ?? 0) / 100),
    shippingProtection: money(row.shipping_protection_fee),
  });

  const amountPaid = money(row.amount_paid);
  return {
    quote, row, expected, amountPaid,
    /** What the operator's reconciliation screen actually decides. */
    mismatch: isTotalMismatch(amountPaid, expected, 0),
    /** The raw disagreement between the two formulas, in cents. */
    centsApart: Math.abs(Math.round(amountPaid * 100) - Math.round(expected * 100)),
  };
}

describe("reconciliation-math agrees with the formula that wrote the row", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const CASES: Array<{
    name: string; items: Array<{ slug: string; quantity: number }>;
    shippingProtection?: boolean; paymentMethod?: string;
    storeCreditCents?: number; pointsToRedeem?: number; bulkEligible?: boolean;
    memberDiscountPercent?: number;
  }> = [
    { name: "one item, paid shipping, taxed, card fee", items: [{ slug: "peptide-a", quantity: 1 }] },
    { name: "protection ticked", items: [{ slug: "peptide-a", quantity: 1 }], shippingProtection: true },
    { name: "over the free-shipping threshold", items: [{ slug: "peptide-b", quantity: 3 }] },
    { name: "free shipping AND protection", items: [{ slug: "peptide-b", quantity: 3 }], shippingProtection: true },
    { name: "a manual method, so no card fee at all", items: [{ slug: "peptide-a", quantity: 2 }], paymentMethod: "zelle" },
    { name: "a price that does not divide evenly (rounding)", items: [{ slug: "peptide-c", quantity: 7 }], shippingProtection: true },
    { name: "mixed basket", items: [{ slug: "peptide-a", quantity: 2 }, { slug: "peptide-c", quantity: 3 }], shippingProtection: true },
    { name: "a large basket", items: [{ slug: "peptide-b", quantity: 11 }, { slug: "peptide-c", quantity: 13 }] },
    { name: "a bulk discount", items: [{ slug: "peptide-b", quantity: 4 }], bulkEligible: true },
    { name: "a bulk discount at the higher tier, with protection", items: [{ slug: "peptide-b", quantity: 8 }], bulkEligible: true, shippingProtection: true },
    { name: "store credit redeemed", items: [{ slug: "peptide-b", quantity: 1 }], storeCreditCents: 2500 },
    { name: "points redeemed", items: [{ slug: "peptide-b", quantity: 1 }], pointsToRedeem: 1500 },
    { name: "store credit AND points AND bulk AND protection", items: [{ slug: "peptide-b", quantity: 6 }], storeCreditCents: 4000, pointsToRedeem: 900, bulkEligible: true, shippingProtection: true },
    { name: "a member discount, which is the only thing that fills discount_amount", items: [{ slug: "peptide-b", quantity: 2 }], memberDiscountPercent: 15 },
    { name: "a member discount with protection and points", items: [{ slug: "peptide-b", quantity: 2 }], memberDiscountPercent: 15, shippingProtection: true, pointsToRedeem: 733 },
  ];

  /** Credit that covers the whole order legitimately lands at $0 paid. */
  const ZERO_TOTAL_CASE = {
    name: "credit larger than the whole order",
    items: [{ slug: "peptide-c", quantity: 1 }],
    storeCreditCents: 500000,
  };

  for (const testCase of CASES) {
    it(`reconciles: ${testCase.name}`, async () => {
      const { expected, amountPaid, mismatch, quote } = await quoteAndReconcile(testCase);
      // A case that priced at zero would satisfy every assertion below while
      // covering nothing.
      expect(amountPaid).toBeGreaterThan(0);
      expect(expected).toBe(amountPaid);
      expect(mismatch).toBe(false);
      // The reconciliation screen is exact to the cent when the fee is recorded.
      expect(quote.finalTotal).toBe(amountPaid);
    });
  }

  it("an order fully covered by store credit reconciles at zero, not as a mismatch", async () => {
    // quoteOrder clamps with Math.max(0, ...) twice; expectedOrderTotal has no
    // clamp at all. They agree here only because quoteOrder also caps the credit
    // it redeems at the order total — remove that cap and the two diverge.
    const { expected, amountPaid, mismatch, row } = await quoteAndReconcile(ZERO_TOTAL_CASE);
    expect(Number(row.store_credit_redeemed_cents)).toBeGreaterThan(0);
    expect(amountPaid).toBe(0);
    expect(expected).toBe(0);
    expect(mismatch).toBe(false);
  });

  it("exercises every term of the formula across the sweep above", async () => {
    // A guard on the guard: if the fixtures ever stop producing a tax, a card
    // fee, a protection fee, a free-shipping order or a paid-shipping order,
    // the cases above would still pass while covering nothing.
    // Sequential: the member context is module-level state, so running these
    // concurrently would let one case read another's balances.
    const results = [];
    for (const c of CASES) results.push(await quoteAndReconcile(c));
    expect(results.some((r) => Number(r.row.tax_amount) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.card_processing_fee) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.card_processing_fee) === 0)).toBe(true);
    expect(results.some((r) => Number(r.row.shipping_protection_fee) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.shipping_amount) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.shipping_amount) === 0)).toBe(true);
    // These three were the gap. Without them, flipping the sign of the discount
    // term in reconciliation-math left every test in this file green.
    expect(results.some((r) => Number(r.row.discount_amount) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.store_credit_redeemed_cents) > 0)).toBe(true);
    expect(results.some((r) => Number(r.row.points_redeemed) > 0)).toBe(true);
  });

  it("a randomised sweep: the two formulas can differ by a cent, and never by more", async () => {
    // Deterministic pseudo-random with a fixed seed, so a failure is
    // reproducible and a green run is not luck about which baskets got drawn.
    let seed = 20260826;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const slugs = Object.keys(PRODUCTS);

    let apart1 = 0;
    const apartMore: Array<Record<string, unknown>> = [];
    const flagged: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 600; i += 1) {
      const items = [{ slug: slugs[next(slugs.length)], quantity: 1 + next(9) }];
      if (next(2) === 0) items.push({ slug: slugs[next(slugs.length)], quantity: 1 + next(5) });
      const result = await quoteAndReconcile({
        items,
        shippingProtection: next(2) === 0,
        paymentMethod: next(4) === 0 ? "zelle" : "card",
        storeCreditCents: next(3) === 0 ? next(5000) : 0,
        pointsToRedeem: next(3) === 0 ? next(3000) : 0,
        bulkEligible: next(2) === 0,
        memberDiscountPercent: next(3) === 0 ? 5 + next(20) : 0,
      });
      const detail = {
        items, expected: result.expected, amountPaid: result.amountPaid,
        centsApart: result.centsApart,
        row: {
          subtotal: result.row.subtotal, shipping: result.row.shipping_amount,
          tax: result.row.tax_amount, discount: result.row.discount_amount,
          cardFee: result.row.card_processing_fee, protection: result.row.shipping_protection_fee,
          creditCents: result.row.store_credit_redeemed_cents, points: result.row.points_redeemed,
        },
      };
      if (result.centsApart === 1) apart1 += 1;
      if (result.centsApart > 1) apartMore.push(detail);
      if (result.mismatch) flagged.push(detail);
    }

    // WHAT THIS FOUND. The two formulas are NOT identical: quoteOrder rounds to
    // the cent at four intermediate steps, expectedOrderTotal rounds once at the
    // end, and on some baskets those disagree by exactly one cent. Recorded, not
    // asserted away — this is the drift, and it is real.
    expect(apart1).toBeGreaterThan(0);

    // WHAT KEEPS IT HARMLESS, and the thing that must not regress: the gap never
    // exceeds a cent, so isTotalMismatch's ±$0.01 band absorbs it and no genuine
    // order is ever accused of not adding up. A two-cent gap WOULD false-flag,
    // which is why this is a bound and not a tolerance.
    expect(apartMore).toEqual([]);
    expect(flagged).toEqual([]);
  });
});
