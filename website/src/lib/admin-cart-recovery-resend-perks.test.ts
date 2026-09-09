import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE RESEND BUTTON, WITH THE EXACT ROW SITTING IN PRODUCTION.
//
// Four override rows are waiting to send with perks ["Free shipping", "2-day
// shipping, on us"], and the sitewide free-shipping switch is on — so the store
// added a second "Free shipping" of its own. The highest-value cart in the
// store ($484, opened, one press from going out) was about to be mailed:
//
//     • Free shipping
//     • Free shipping
//     • 2-day shipping, on us
//
// The sweep was fixed first and this path was not, because each built the list
// with its own copy of the same two lines. This test drives the real
// resendCartRecoveryEmail with the real row and reads the rendered bullets.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ html: "", text: "" }));

// The row as stored, verbatim.
vi.mock("@/lib/cart-recovery-overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cart-recovery-overrides")>()),
  loadCartRecoveryOverrides: async () => new Map([[
    "cart-nikki::t24h",
    {
      cartId: "cart-nikki",
      stage: "t24h",
      offerKey: "labor_day_bac_water_2_70",
      perks: ["Free shipping", "2-day shipping, on us"],
      note: "last chance: 70% (= Buy 2 Get 1 + 40% stacked) + 2 Recon Water",
      consumedAt: null,
    },
  ]]),
  markCartRecoveryOverrideConsumed: async () => {},
}));

vi.mock("@/lib/email/marketing", () => ({
  isMarketingSuppressed: async () => false,
  sendMarketingEmail: async (input: Record<string, unknown>) => {
    state.html = String(input.html ?? "");
    state.text = String(input.text ?? "");
    return { success: true, providerMessageId: "msg" };
  },
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    issueCustomerOffer: async () => ({ token: "tok", expiresAt: "2026-09-13T00:00:00.000Z" }),
  };
});

// Her cart: GLP-3 on a dose that costs far more than the product's headline.
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async () => ([
    {
      slug: "glp-3", name: "GLP-3", price: "$49.99", image: "/images/glp3.jpg", batchNumber: "VL-0001",
      doses: [
        { id: "dose-base", label: "5mg", price: "$49.99", isDefault: true },
        { id: "dose-big", label: "20mg", price: "$169.99", isDefault: false },
      ],
    },
    { slug: "bac-water", name: "Recon Water (0.9% Benzyl Alcohol)", price: "$14.99", doses: [] },
  ]),
}));

vi.mock("@/lib/email/frequency", () => ({ claimMarketingSend: async () => ({ outcome: "claimed", logId: "log-1" }) }));
vi.mock("@/lib/bxgy-promotions", () => ({ getApplicableBxgyPromotions: async () => [] }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({ t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true, discountPercent: 5, couponExpirationHours: 48 }),
  // THE SWITCH IS ON, exactly as it is in production.
  getShippingConfig: async () => ({ freeShippingSitewide: true, domesticFee: 0, freeShippingThreshold: 200, internationalFee: 0, internationalFreeShippingThreshold: 0, handlingFeeRate: 0 }),
}));

const CART = {
  id: "cart-nikki", email: "shopper@example.test", customer_name: "Nikki",
  items: [
    { slug: "glp-3", name: "GLP-3", quantity: 3, unitPrice: 169.99, variantId: "dose-big" },
    { slug: "bac-water", name: "Recon Water", quantity: 1, unitPrice: 14.99 },
  ],
  // The STALE snapshot, lower than the live basket.
  cart_value_cents: 48416,
  status: "active",
};

vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "update", "insert"]) self[m] = () => self;
    self.maybeSingle = async () => ({ data: table === "abandoned_carts" ? CART : null, error: null });
    self.single = async () => ({ data: { id: "row-1" }, error: null });
    self.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
    return self;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});

beforeEach(() => { state.html = ""; state.text = ""; vi.clearAllMocks(); });

/** The perk bullets as rendered, in order. */
function bullets(html: string): string[] {
  return (html.match(/&#8226;<\/span>&nbsp;&nbsp;([^<]+)/g) ?? [])
    .map((bullet) => bullet.replace(/.*&nbsp;/, "").trim());
}

describe("the resend that was about to go out", () => {
  it("states each perk once, with the store's and the operator's merged", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");

    const result = await resendCartRecoveryEmail("cart-nikki", "t24h");

    expect(result.success).toBe(true);
    expect(bullets(state.html)).toEqual(["Free shipping", "2-day shipping, on us"]);
  });

  it("prices her cart at the dose she chose, not the product's headline", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");

    await resendCartRecoveryEmail("cart-nikki", "t24h");

    // 3 x $169.99 + $14.99 = $524.96. On the product's headline price it would
    // read $164.96, and the stored snapshot says $484.16 — the email must show
    // what the basket is actually worth when she opens it.
    expect(state.html).toContain("$524.96");
    expect(state.html).not.toContain("$164.96");
    expect(state.html).toContain("GLP-3 20mg");
  });

  it("names the gift the offer actually grants", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");

    await resendCartRecoveryEmail("cart-nikki", "t24h");

    expect(`${state.html} ${state.text}`).toContain("2 free Recon Water");
    expect(state.html).toContain("70%");
  });
});
