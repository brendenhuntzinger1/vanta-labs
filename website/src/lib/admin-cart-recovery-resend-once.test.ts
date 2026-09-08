import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PRESSING RESEND TWICE ON A GIFT MUST NOT SEND A SECOND GIFT.
//
// This is the one send path with no structural protection against it, and the
// reason is worth stating: the sweep claims (cart, stage) and so physically
// cannot send twice, while the operator resend REUSES that row — repeating a
// send is literally what the button is for. The frequency guard does not cover
// it either, because cart_recovery sends are deliberately exempt from each
// other's quiet window ("one conversation").
//
// So a second press would have reached issueCustomerOffer, which keeps at most
// one live token per address per campaign — meaning it retires the first and
// mints a new one. The customer gets two emails and the link in the one they
// already opened stops working. consumed_at is what stands in the way.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  consumedAt: null as string | null,
  sends: [] as string[],
  minted: 0,
}));

vi.mock("@/lib/cart-recovery-overrides", () => ({
  loadCartRecoveryOverrides: async () => new Map([[
    "cart-1::t24h",
    { cartId: "cart-1", stage: "t24h", offerKey: "labor_day_bac_water_2", perks: [], note: null, consumedAt: state.consumedAt },
  ]]),
  markCartRecoveryOverrideConsumed: async () => { state.consumedAt = new Date().toISOString(); },
}));

vi.mock("@/lib/email/marketing", () => ({
  isMarketingSuppressed: async () => false,
  sendMarketingEmail: async (input: Record<string, unknown>) => {
    state.sends.push(String(input.templateKey));
    return { success: true, providerMessageId: "msg" };
  },
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    issueCustomerOffer: async () => { state.minted += 1; return { token: `tok-${state.minted}`, expiresAt: new Date().toISOString() }; },
  };
});

// THE RESEND RENDERS FROM THE CATALOGUE NOW, exactly as the sweep does (AUTH-3)
// — it used to pass the tracking beacon's stored snapshot straight into the
// template. Without this mock the catalogue comes back empty and the resend
// correctly refuses, on the grounds that nothing in the cart is a live product.
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async () => ([
    { slug: "bpc-157", name: "BPC-157", price: "$42.99", image: "/images/bpc.jpg", batchNumber: "VL-BPC-0826", doses: [] },
  ]),
}));

vi.mock("@/lib/email/frequency", () => ({
  claimMarketingSend: async () => ({ outcome: "claimed", logId: "log-1" }),
}));
vi.mock("@/lib/bxgy-promotions", () => ({ getApplicableBxgyPromotions: async () => [] }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({ t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true, discountPercent: 5, couponExpirationHours: 48 }),
  getShippingConfig: async () => ({ freeShippingSitewide: true, domesticFee: 0, freeShippingThreshold: 200, internationalFee: 0, internationalFreeShippingThreshold: 0, handlingFeeRate: 0 }),
}));

const CART = {
  id: "cart-1", email: "shopper@example.test", customer_name: "Sam",
  items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1 }], cart_value_cents: 4299, status: "active",
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

beforeEach(() => {
  state.consumedAt = null;
  state.sends = [];
  state.minted = 0;
  vi.clearAllMocks();
});

describe("the operator resend on a cart whose stage carries a gift", () => {
  it("sends it the first time, and mints exactly one entitlement", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");

    const result = await resendCartRecoveryEmail("cart-1", "t24h");

    expect(result.success).toBe(true);
    expect(state.sends).toEqual(["cartRecoveryGiftTemplate"]);
    expect(state.minted).toBe(1);
    expect(state.consumedAt).toBeTruthy();
  });

  it("REFUSES the second press, mints nothing, and says why", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");

    await resendCartRecoveryEmail("cart-1", "t24h");
    const second = await resendCartRecoveryEmail("cart-1", "t24h");

    expect(second.success).toBe(false);
    // One send, one entitlement — the customer's existing link still works.
    expect(state.sends).toHaveLength(1);
    expect(state.minted).toBe(1);
    expect(second.error).toMatch(/already went out/i);
    expect(second.error).toMatch(/break the link/i);
  });
});
