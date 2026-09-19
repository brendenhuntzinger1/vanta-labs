import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import type { BxgyPromotion } from "@/lib/bxgy-engine";

// ---------------------------------------------------------------------------
// THE WALLET SHEET AND THE CHARGE MUST AGREE ABOUT THE PRIZE.
//
// The express lane priced its quotes WITHOUT the offer token until 2026-09-19,
// so a wallet shopper holding a free vial was priced as though they held
// nothing. EXPRESS_OFFER_PARITY kept the lane shut rather than ship that, and
// this file is the behavioural half of what re-opens it: the guard test next
// door proves the WIRING is present, and proving a symbol appears in a file is
// not proving the money is right.
//
// WHAT IS ACTUALLY UNDER TEST. Express takes three quotes of one cart:
//
//   sheet      mode "address_optional", in session/route.ts — the amount the
//              customer approves in the wallet, before any address exists;
//   recheck    mode "address_optional", in authorize/route.ts — compared to
//              the sheet's amount, and the payment is REFUSED if they differ;
//   charge     mode "full", in authorize/route.ts — builds the order row.
//
// The card lane takes one, mode "full". So there are two distinct claims, and
// the first version of this file confused them:
//
//   LANE PARITY   charge(express) must price a reward exactly as the card
//                 lane does. Same mode, same inputs — so this is really the
//                 claim that nothing in the express path drops the token.
//   MODE PARITY   sheet and charge must agree on everything that does not
//                 depend on an address, because the customer approved the
//                 sheet and is charged the charge. Shipping and tax may
//                 legitimately differ; the reward economics may not.
//
// And the invariant that binds them, stated the way authorize/route.ts spends
// it: what the wallet shows, plus the shipping and tax it later locks, is
// exactly what the card is charged.
//
// NOTHING HERE MOCKS THE OFFER LOOKUP. peekCustomerOffer is the real function,
// running against a faked customer_offers ROW — because the first version
// stubbed the lookup, and its "expired offer is withheld" test then proved
// only that the stub had no expiry check. Expiry, revocation, prior redemption
// and the email binding are all decided by the product here.
// ---------------------------------------------------------------------------

const promotionState = vi.hoisted(() => ({
  promotions: [] as BxgyPromotion[],
}));

type OfferRow = {
  id: string;
  offer_key: string;
  email: string;
  reward_kind: string;
  product_slug: string | null;
  gift_items: unknown;
  percent_off: number | null;
  max_discount_cents: number | null;
  quantity: number;
  variant_id: string | null;
  min_subtotal_cents: number;
  expires_at: string;
  reserved_order_id: string | null;
  redeemed_at: string | null;
  revoked_at: string | null;
};

const offerState = vi.hoisted(() => ({
  /** The customer_offers row, exactly as the table holds it. */
  row: null as null | Record<string, unknown>,
  /** The token that row was minted for. Any other token hashes to no row. */
  token: "the-real-token",
}));

/** Tracked stock, keyed the way getStockLevelsBySlugs keys it. Empty = untracked. */
const stockState = vi.hoisted(() => ({ levels: new Map<string, number>() }));

vi.mock("@/lib/supabase-server", async () => {
  const { createHash } = await import("node:crypto");
  // The same hash hashOfferToken computes. A row is found only by the token it
  // was minted for, so a foreign or malformed token misses exactly as it would
  // in Postgres rather than by a special case in the fake.
  const hashOf = (token: string) => createHash("sha256").update(String(token ?? "").trim()).digest("hex");

  const rpc = async (fn: string) => {
    if (fn === "bxgy_count_redemptions") return { data: 0, error: null };
    if (fn === "bxgy_claim_redemption") return { data: true, error: null };
    if (fn === "bxgy_release_redemption") return { data: true, error: null };
    return { data: null, error: null };
  };

  const chain = (table: string) => {
    const filters = new Map<string, unknown>();
    const self: Record<string, unknown> = {};
    for (const method of ["select", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.eq = (column: string, value: unknown) => {
      filters.set(column, value);
      return self;
    };
    const row = () => {
      if (table !== "customer_offers" || !offerState.row) return null;
      return filters.get("token_hash") === hashOf(offerState.token) ? offerState.row : null;
    };
    self.maybeSingle = async () => ({ data: row(), error: null });
    self.single = async () => ({ data: row(), error: null });
    self.then = (onResolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
    return self;
  };

  const client = { from: (table: string) => chain(table), rpc };
  return { supabaseAdmin: client, createServerClient: () => client };
});

vi.mock("@/lib/rewards", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/rewards");
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

const DOSES = [
  { id: "dose-5mg", label: "5mg", slugSuffix: "5mg", sku: "KLW-5", price: "$60.00", stockStatus: "In Stock", isDefault: true, imageUrl: "/klow-5.png" },
  { id: "dose-30mg", label: "30mg", slugSuffix: "30mg", sku: "KLW-30", price: "$170.00", stockStatus: "In Stock", isDefault: false, imageUrl: "/klow-30.png" },
];

const PRODUCTS: Record<string, Record<string, unknown>> = {
  "peptide-b": { name: "Peptide B", category: "Research Peptides", price: "$40.00", stockStatus: "In Stock", image: "/b.png", description: "", doses: [] },
  "ghk-cu": { name: "GHK-Cu", category: "Research Peptides", price: "$47.99", stockStatus: "In Stock", image: "/g.png", description: "", doses: [] },
  "klow": { name: "KLOW", category: "Research Peptides", price: "$60.00", stockStatus: "In Stock", image: "/klow.png", description: "", doses: DOSES },
};

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.filter((slug) => slug in PRODUCTS).map((slug) => ({ ...PRODUCTS[slug], slug })),
  getStockLevelsBySlugs: async () => new Map(stockState.levels),
}));

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({
      bxgyPromotions: promotionState.promotions,
      bundleStacking: false,
      bundleConfig: { twoUnitPercent: 0, threePlusPercent: 0, fiveUnitPercent: 0, tenUnitPercent: 0 },
    }),
    getBulkSavingsControlConfig: async () => ({ enabled: false, tier1Threshold: 300, tier1Percent: 5, tier2Threshold: 800, tier2Percent: 12 }),
    // One nexus state, so tax is a real non-zero figure the address decides —
    // otherwise the "shipping and tax are the only permitted divergence" claim
    // would be tested against two zeroes.
    getSalesTaxSettings: async () => ({ nexusStates: ["TX"], rateOverrides: { TX: 8.25 }, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    // A real fee under a real threshold, so a free-shipping reward is worth
    // something and shipping is genuinely address-dependent.
    getShippingConfig: async () => ({ domesticFee: 9.99, freeShippingThreshold: 150, internationalFee: 24.99, internationalFreeShippingThreshold: 300, handlingFeeRate: 0 }),
    getCardProcessingFeeConfig: async () => ({ enabled: false, percentage: 0, label: "Service Fee", noticeText: "" }),
    getReferralProgramConfig: async () => ({ enabled: true, discountPercent: 10, bundleReferralPercent: 5, personalDiscountPercent: 0, defaultCommissionPercent: 10, commissionsPaused: false }),
    getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 1, commissionPercent: 10, cookieWindowDays: 30, autoApprove: false }),
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
  email: "lapsed@example.test",
  fullName: "Lapsed Buyer",
  address: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
};

/** What the express sheet knows before the wallet hands an address back. */
const SHEET_CUSTOMER = {
  email: CUSTOMER.email,
  fullName: "",
  address: "",
  city: "",
  postalCode: "",
  country: "",
};

function promotion(id: string): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true };
}

const HOURS = 60 * 60 * 1000;

function offer(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: "offer-1",
    offer_key: "spin:winback_2026q4",
    email: CUSTOMER.email,
    reward_kind: "free_product",
    product_slug: "ghk-cu",
    gift_items: null,
    percent_off: null,
    max_discount_cents: null,
    quantity: 1,
    variant_id: null,
    min_subtotal_cents: 6000,
    expires_at: new Date(Date.now() + 72 * HOURS).toISOString(),
    reserved_order_id: null,
    redeemed_at: null,
    revoked_at: null,
    ...overrides,
  };
}

type Cart = Array<{ id: string; quantity: number }>;

/**
 * One cart, quoted the three ways the two lanes quote it.
 *
 * `card` and `charge` are deliberately the same call with the same arguments:
 * that IS the claim — express builds its order from a quote indistinguishable
 * from the card lane's, so anything the express route failed to pass along
 * (the offer token being the whole reason this file exists) shows up as a
 * difference between the route's inputs and these.
 */
async function quoteLanes(items: Cart, offerToken?: string) {
  const { quoteOrder } = await import("@/lib/quote-order");
  const inputs = { items, offerToken, pointsToRedeem: 0 as const };
  const card = await quoteOrder({ ...inputs, customer: CUSTOMER, mode: "full" });
  const sheet = await quoteOrder({ ...inputs, customer: SHEET_CUSTOMER, mode: "address_optional" });
  const recheck = await quoteOrder({ ...inputs, customer: SHEET_CUSTOMER, mode: "address_optional" });
  const charge = await quoteOrder({ ...inputs, customer: CUSTOMER, mode: "full" });
  return { card, sheet, recheck, charge };
}

type Lanes = Awaited<ReturnType<typeof quoteLanes>>;
type Quote = Lanes["card"];

/** Everything about a reward a customer would notice if it differed. */
const rewardShape = (q: Quote) => ({
  subtotal: q.subtotal,
  discountAmount: q.discountAmount,
  rewardKind: q.appliedOffer?.rewardKind ?? null,
  productApplied: q.appliedOffer?.productApplied ?? null,
  percentApplied: q.appliedOffer?.percentApplied ?? null,
  shortfallCents: q.offerShortfallCents ?? null,
  withdrawnBy: q.offerWithdrawnBy ?? null,
  giftLines: q.lineItems.filter((l) => l.gift === true).map((l) => ({
    id: l.product.id,
    name: l.product.name,
    variantLabel: l.product.variantLabel ?? null,
    quantity: l.quantity,
    price: l.product.price,
  })),
  paidLines: q.lineItems.filter((l) => l.gift !== true).map((l) => ({
    id: l.product.id, quantity: l.quantity, price: l.product.price,
  })),
});

const cents = (dollars: number) => Math.round(dollars * 100);

/**
 * The three claims, asserted together on every case in the matrix.
 *
 * Every test in this file runs all three, because a reward that satisfies one
 * and not another is exactly the shape of the bug this lane was shut for.
 */
function expectParity(lanes: Lanes, why: string) {
  // 1. LANE PARITY — the order express builds is priced as the card lane
  //    would price it.
  expect(rewardShape(lanes.charge), `express and card disagree: ${why}`)
    .toEqual(rewardShape(lanes.card));

  // 2. MODE PARITY — the sheet the customer approved describes the same
  //    reward as the order they are charged for. shippingApplied is excluded
  //    from rewardShape and asserted separately below; it is the one field
  //    that cannot be known without an address.
  expect(rewardShape(lanes.sheet), `sheet and charge disagree: ${why}`)
    .toEqual(rewardShape(lanes.charge));

  // 3. THE AMOUNT CHECK AT AUTHORIZE — the recheck must reproduce the sheet's
  //    figure, or authorize refuses the payment outright. A reward that
  //    resolves non-deterministically fails here, and the customer sees
  //    "Your order total changed" on a cart nobody touched.
  expect(lanes.recheck.addressIndependentCents, `the amount check would refuse: ${why}`)
    .toBe(lanes.sheet.addressIndependentCents);

  // 4. WHAT THE WALLET SHOWED IS WHAT THE CARD PAYS. authorize spends exactly
  //    this sum: intent.amount_cents + lockedShippingCents + lockedTaxCents.
  //    If it is not the charge, the customer approved one number and was
  //    billed another.
  expect(
    lanes.sheet.addressIndependentCents + cents(lanes.charge.shipping) + cents(lanes.charge.taxAmount),
    `the wallet's amount is not what the card pays: ${why}`,
  ).toBe(cents(lanes.charge.finalTotal));
}

beforeEach(() => {
  vi.resetModules();
  promotionState.promotions = [];
  offerState.row = null;
  offerState.token = "the-real-token";
  stockState.levels = new Map();
});

const TOKEN = "the-real-token";

describe("the wheel reward matrix, priced by both lanes", () => {
  it("no reward at all — the lanes price a plain cart identically", async () => {
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 2 }]);
    expectParity(lanes, "a cart with no reward");
    expect(lanes.charge.appliedOffer).toBeNull();
    expect(lanes.sheet.appliedOffer).toBeNull();
  });

  it("a single-dose free vial, qualified", async () => {
    offerState.row = offer();
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 2 }], TOKEN);
    expectParity(lanes, "a qualified free vial");
    expect(lanes.charge.appliedOffer?.rewardKind).toBe("free_product");
    const gift = rewardShape(lanes.charge).giftLines;
    expect(gift).toHaveLength(1);
    expect(gift[0].price, "a gift that is not free").toBe(0);
    expect(gift[0].id).toBe("ghk-cu");
  });

  it("a multi-dose free vial grants the EXACT strength that was won", async () => {
    // The 30mg rung, not the 5mg default. A shopper who cleared a $170 floor
    // for the strong one must not be shipped the entry dose.
    offerState.row = offer({ product_slug: "klow", variant_id: "dose-30mg", min_subtotal_cents: 6000 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 2 }], TOKEN);
    expectParity(lanes, "a laddered multi-dose prize");
    const gift = rewardShape(lanes.charge).giftLines;
    expect(gift).toHaveLength(1);
    expect(gift[0].variantLabel, "the wrong strength was gifted").toBe("30mg");
    expect(gift[0].id).toBe("klow::dose-30mg");
    expect(gift[0].price).toBe(0);
  });

  it("a percentage reward", async () => {
    offerState.row = offer({ reward_kind: "percent", product_slug: null, percent_off: 20, min_subtotal_cents: 0 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 2 }], TOKEN);
    expectParity(lanes, "a percentage reward");
    expect(lanes.charge.appliedOffer?.rewardKind).toBe("percent");
    expect(lanes.charge.discountAmount).toBeGreaterThan(0);
    expect(lanes.charge.appliedOffer?.percentApplied).toBe(true);
  });

  it("a free-shipping reward: the sheet promises it, the charge decides it", async () => {
    // THE ONE PERMITTED DIVERGENCE, and it is a difference between QUOTE MODES
    // rather than between lanes. With no address, shipping is not knowable, so
    // "address_optional" promises the waiver optimistically; the "full" quote
    // that builds the order decides it against the real destination. Both
    // express quotes are in this file, so the divergence is pinned rather than
    // discovered later as a mismatch.
    offerState.row = offer({ reward_kind: "free_shipping", product_slug: null, min_subtotal_cents: 3500 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 2 }], TOKEN);
    expectParity(lanes, "a free-shipping reward");

    expect(lanes.sheet.appliedOffer?.shippingApplied, "the sheet should promise the waiver").toBe(true);
    expect(lanes.charge.appliedOffer?.shippingApplied, "the charge should honour the waiver").toBe(true);
    // And the waiver is real money: $80 is under the $150 threshold, so this
    // order would otherwise have paid the $9.99 fee.
    expect(lanes.charge.shipping).toBe(0);
  });

  it("a free-shipping reward on an order that already ships free grants nothing, and is not spent", async () => {
    // Over the store's own threshold the waiver changes no total, so the
    // reward is withheld rather than consumed — it survives for an order it
    // can actually improve. The sheet says so too, so the customer is not told
    // a reward applied and then shown an order without it.
    offerState.row = offer({ reward_kind: "free_shipping", product_slug: null, min_subtotal_cents: 0 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 5 }], TOKEN);
    expect(lanes.charge.subtotal, "fixture no longer clears the free-shipping threshold").toBeGreaterThan(150);
    expect(lanes.charge.appliedOffer, "a waiver worth nothing was recorded as applied").toBeNull();
    expect(lanes.charge.shipping).toBe(0);
    // Lane parity still holds; mode parity does not bind shippingApplied, and
    // the sheet's optimism is the documented safe direction.
    expect(rewardShape(lanes.charge)).toEqual(rewardShape(lanes.card));
    expect(lanes.recheck.addressIndependentCents).toBe(lanes.sheet.addressIndependentCents);
  });
});

describe("the qualification boundary, to the cent", () => {
  // $40 a unit, three units — the floor is set so the boundary lands between
  // whole units and a rounding slip cannot hide inside a unit price.
  it("one cent below the minimum: withheld, with the same shortfall in both lanes", async () => {
    offerState.row = offer({ min_subtotal_cents: 12_001 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "one cent short of the floor");
    expect(lanes.charge.appliedOffer, "a gift was granted below its own minimum").toBeNull();
    expect(lanes.charge.offerShortfallCents).toBe(1);
    expect(lanes.charge.offerWithdrawnBy).toBe("minimum");
  });

  it("exactly at the minimum: granted", async () => {
    offerState.row = offer({ min_subtotal_cents: 12_000 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "exactly at the floor");
    expect(lanes.charge.appliedOffer?.rewardKind).toBe("free_product");
  });

  it("one cent above the minimum: granted", async () => {
    offerState.row = offer({ min_subtotal_cents: 11_999 });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "one cent over the floor");
    expect(lanes.charge.appliedOffer?.rewardKind).toBe("free_product");
  });
});

describe("a reward that may not be spent", () => {
  it("expired — withheld in both lanes", async () => {
    offerState.row = offer({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "an expired reward");
    expect(lanes.charge.appliedOffer, "an expired prize was honoured").toBeNull();
    expect(rewardShape(lanes.charge).giftLines).toHaveLength(0);
  });

  it("expiring exactly now is expired, not live", async () => {
    // peekCustomerOffer's boundary is `<= now`. A prize is dead on its stroke,
    // in both lanes, so the wheel's 72 hours cannot become 72 hours plus a
    // round trip on whichever lane quoted last.
    offerState.row = offer({ expires_at: new Date(Date.now()).toISOString() });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a reward expiring on the stroke");
    expect(lanes.charge.appliedOffer).toBeNull();
  });

  it("already redeemed — withheld in both lanes", async () => {
    offerState.row = offer({ redeemed_at: new Date().toISOString() });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a redeemed reward");
    expect(lanes.charge.appliedOffer, "a spent prize was spent twice").toBeNull();
  });

  it("revoked — withheld in both lanes", async () => {
    offerState.row = offer({ revoked_at: new Date().toISOString() });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a revoked reward");
    expect(lanes.charge.appliedOffer, "a revoked prize was honoured").toBeNull();
  });

  it("bound to somebody else's email — withheld in both lanes", async () => {
    offerState.row = offer({ email: "someone.else@example.test" });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a reward bound to another customer");
    expect(lanes.charge.appliedOffer, "a prize crossed accounts").toBeNull();
  });

  it("held by another checkout — priced advisorily, and identically", async () => {
    // A peek takes no lock by design, so a held offer still prices. What stops
    // the double-spend is the reserve at order creation, proved separately.
    // What matters here is that both lanes make the SAME optimistic read, so
    // the loser is refused rather than silently charged a different total.
    offerState.row = offer({ reserved_order_id: "order-somebody-else" });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a reward held by another order");
  });

  it("no token at all — the reward is simply absent, not an error", async () => {
    offerState.row = offer();
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }]);
    expectParity(lanes, "a missing token");
    expect(lanes.charge.appliedOffer).toBeNull();
  });

  it("a malformed token — refused, and refused identically", async () => {
    offerState.row = offer();
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], "not-a-real-token-\u0000\u0000");
    expectParity(lanes, "a malformed token");
    expect(lanes.charge.appliedOffer).toBeNull();
  });

  it("somebody else's valid-looking token — refused, and refused identically", async () => {
    offerState.row = offer();
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], "a-perfectly-well-formed-but-wrong-token");
    expectParity(lanes, "a token that hashes to no row");
    expect(lanes.charge.appliedOffer).toBeNull();
  });
});

describe("the sold-out cases the wheel can produce", () => {
  it("the gifted product is out of stock — withheld, and both lanes agree why", async () => {
    offerState.row = offer();
    stockState.levels = new Map([["ghk-cu", 0]]);
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a sold-out gift");
    expect(lanes.charge.appliedOffer).toBeNull();
    expect(lanes.charge.offerWithdrawnBy).toBe("unavailable");
  });

  it("the gifted DOSE is out of stock — withheld, not downgraded to the default", async () => {
    offerState.row = offer({ product_slug: "klow", variant_id: "dose-30mg" });
    stockState.levels = new Map([["dose-30mg", 0], ["dose-5mg", 40]]);
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a sold-out strength");
    expect(lanes.charge.appliedOffer, "a strength the customer did not win was substituted").toBeNull();
    expect(lanes.charge.offerWithdrawnBy).toBe("unavailable");
    expect(rewardShape(lanes.charge).giftLines).toHaveLength(0);
  });

  it("the gifted dose was retired between the spin and the checkout — withheld", async () => {
    offerState.row = offer({ product_slug: "klow", variant_id: "dose-that-no-longer-exists" });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a retired strength");
    expect(lanes.charge.appliedOffer).toBeNull();
    expect(lanes.charge.offerWithdrawnBy).toBe("unavailable");
  });
});

describe("the reward beside the store's other discounts", () => {
  it("a promotion running at the same time does not change what each lane grants", async () => {
    promotionState.promotions = [promotion(defaultBxgyPromotions()[0].id)];
    offerState.row = offer();
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 4 }], TOKEN);
    expectParity(lanes, "a reward alongside a live promotion");
  });

  it("a gift of something already in the cart frees those units in both lanes", async () => {
    offerState.row = offer({ product_slug: "peptide-b" });
    const lanes = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    expectParity(lanes, "a gift absorbed from the cart");
    expect(lanes.charge.offerAbsorbedUnits).toBe(1);
  });
});

describe("the email the express lane resolves the prize against", () => {
  // THE THREE-EMAIL PROBLEM, which is what makes this lane different from the
  // card lane rather than merely a second copy of it.
  //
  // The card lane has ONE email: the shopper typed it, the quote resolves the
  // offer against it, and reserveCustomerOffer binds against the same value.
  // Express has three chances to disagree:
  //
  //   session + quoteA   `intent.customer_email` — the signed-in account's
  //                      address, and EMPTY STRING for a guest, because a
  //                      guest has typed nothing when the sheet is armed;
  //   quoteFull          the wallet contact's email, which is whatever address
  //                      the shopper has on file with Apple;
  //   the reserve        the wallet contact's email again.
  //
  // peekCustomerOffer refuses an empty email and refuses a mismatched one, so
  // these three can and do resolve to different answers for the same cart.
  // Both directions cost a customer something, so both are pinned here.

  async function expressQuotes(sheetEmail: string, walletEmail: string, items: Cart, offerToken?: string) {
    const { quoteOrder } = await import("@/lib/quote-order");
    const inputs = { items, offerToken, pointsToRedeem: 0 as const };
    const quoteA = await quoteOrder({
      ...inputs,
      customer: { ...SHEET_CUSTOMER, email: sheetEmail },
      mode: "address_optional",
    });
    const quoteFull = await quoteOrder({
      ...inputs,
      customer: { ...CUSTOMER, email: walletEmail },
      mode: "full",
    });
    return { quoteA, quoteFull };
  }

  it("a GUEST's sheet and their order must not disagree about the prize", async () => {
    // A guest has no `intent.customer_email`, so quoteA prices no gift; the
    // wallet then hands back the very address the prize was mailed to, and
    // quoteFull prices one. The order row and its items are built from quoteA
    // — so the customer is charged full price and receives no vial — while
    // `quoteFull.appliedOffer` is what triggers reserveCustomerOffer, so the
    // prize is CONSUMED. Strictly worse than the bug this work set out to fix,
    // which at least left the token spendable.
    offerState.row = offer();
    const { quoteA, quoteFull } = await expressQuotes("", CUSTOMER.email, [{ id: "peptide-b", quantity: 3 }], TOKEN);
    expect(
      Boolean(quoteFull.appliedOffer),
      "the order-building quote granted a prize the wallet sheet never priced",
    ).toBe(Boolean(quoteA.appliedOffer));
  });

  it("a SIGNED-IN shopper paying from a different Apple address must not disagree either", async () => {
    // The mirror image. The account holds the prize, so the sheet is priced
    // with the gift; the wallet contact is a different address, so quoteFull
    // withholds it and nothing reserves the token. The order is written from
    // quoteA — free vial included — and the prize stays spendable, so the same
    // customer can collect it again tomorrow.
    offerState.row = offer();
    const { quoteA, quoteFull } = await expressQuotes(
      CUSTOMER.email,
      "apple-id@icloud.test",
      [{ id: "peptide-b", quantity: 3 }],
      TOKEN,
    );
    expect(
      Boolean(quoteFull.appliedOffer),
      "the wallet sheet priced a prize the order-building quote refuses to reserve",
    ).toBe(Boolean(quoteA.appliedOffer));
  });
});

describe("what the token is actually worth", () => {
  it("the SAME cart is priced differently with and without it — which is the bug that was shipped", async () => {
    // The express lane omitted offerToken entirely. This is what that cost:
    // the identical basket, one quote holding the gift and one not.
    offerState.row = offer();
    const withToken = await quoteLanes([{ id: "peptide-b", quantity: 3 }], TOKEN);
    const without = await quoteLanes([{ id: "peptide-b", quantity: 3 }]);
    expect(withToken.sheet.appliedOffer?.rewardKind).toBe("free_product");
    expect(without.sheet.appliedOffer).toBeNull();
    expect(rewardShape(withToken.charge).giftLines).toHaveLength(1);
    expect(rewardShape(without.charge).giftLines).toHaveLength(0);
    // And the wallet sheet itself carries the difference, which is the half a
    // string-presence test cannot see: the amount Apple shows the customer.
    expect(withToken.sheet.addressIndependentCents).toBe(without.sheet.addressIndependentCents);
    expect(rewardShape(withToken.sheet).giftLines, "the sheet did not carry the prize").toHaveLength(1);
  });
});
