import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A RESEND MUST NOT DELETE WHAT THE CUSTOMER ALREADY DID.
//
// "Resend" reuses the one (cart, stage) row in abandoned_cart_emails, because a
// unique index allows only one. It also used to clear opened_at and clicked_at
// on the way past, on the reasoning that tracking should reflect the new send
// rather than a stale earlier one.
//
// The effect was to erase a recorded fact. A shopper who opened their 72-hour
// message, clicked through and did not buy, whose cart an operator then resent,
// came out of that write looking as though they had never engaged at all.
//
// Two readers are wrong afterwards. The recovery panel's open and click rates
// are the visible one. The subject-line experiment is the expensive one:
// per-arm tallies come from these same columns, so engagement vanishing from
// whichever arm an operator happened to resend biases the comparison itself —
// and an experiment that loses data unevenly is worse than no experiment.
//
// Nothing is lost by keeping them. Every send has its own email_send_log row
// with its own timeline, and stampSendLogEngagement stamps exactly the newest.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  /** Every update issued against abandoned_cart_emails, in order. */
  trackingUpdates: [] as Array<Record<string, unknown>>,
  sends: [] as string[],
}));

vi.mock("@/lib/cart-recovery-overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cart-recovery-overrides")>()),
  loadCartRecoveryOverrides: async () => new Map(),
}));

vi.mock("@/lib/email/marketing", () => ({
  isMarketingSuppressed: async () => false,
  sendMarketingEmail: async (input: Record<string, unknown>) => {
    state.sends.push(String(input.templateKey));
    return { success: true, providerMessageId: "msg" };
  },
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async () => ([
    { slug: "bpc-157", name: "BPC-157", price: "$42.99", image: "/images/bpc.jpg", batchNumber: "VL-BPC-0826", doses: [] },
  ]),
  getStockLevelsBySlugs: async () => new Map<string, number>(),
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

/** The row as it stands: this stage went out, and the shopper opened AND clicked it. */
const TRACKING_ROW = {
  id: "row-1",
  opened_at: "2026-09-11T12:00:00.000Z",
  clicked_at: "2026-09-11T12:04:00.000Z",
};

vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "single"]) self[m] = () => self;
    self.update = (patch: Record<string, unknown>) => {
      if (table === "abandoned_cart_emails") state.trackingUpdates.push(patch);
      return self;
    };
    self.insert = () => self;
    self.maybeSingle = async () => ({
      data: table === "abandoned_carts" ? CART : table === "abandoned_cart_emails" ? TRACKING_ROW : null,
      error: null,
    });
    self.single = async () => ({ data: { id: "row-1" }, error: null });
    self.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
    return self;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});

beforeEach(() => {
  state.trackingUpdates = [];
  state.sends = [];
});

describe("resending a stage that was already opened and clicked", () => {
  it("moves sent_at forward", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");
    const result = await resendCartRecoveryEmail("cart-1", "t30m");
    expect(result.success).toBe(true);
    expect(state.sends).toHaveLength(1);
    expect(state.trackingUpdates[0]).toHaveProperty("sent_at");
  });

  it("does NOT clear opened_at or clicked_at", async () => {
    // The assertion this file exists for. Writing null here destroys the only
    // record that this shopper engaged with this stage.
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");
    await resendCartRecoveryEmail("cart-1", "t30m");

    for (const patch of state.trackingUpdates) {
      expect(patch, JSON.stringify(patch)).not.toHaveProperty("opened_at");
      expect(patch, JSON.stringify(patch)).not.toHaveProperty("clicked_at");
    }
  });
});
