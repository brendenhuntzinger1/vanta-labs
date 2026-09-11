import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE OPERATOR RESEND KEEPS THE SAME FLOOR THE SWEEP KEEPS.
 *
 * Cart stages are exempt from the 24-hour quiet period against each other, so
 * the frequency guard lets a resend go minutes after the sweep's own stage.
 * On 2026-09-07 an operator batch at 16:26 put a third cart email of the day
 * into two real customers' inboxes. The sweep now holds a stage until
 * MIN_STAGE_GAP_MS has passed since the previous one; a resend must not be
 * the way round that.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  lastStageSentAt: null as string | null,
  sends: [] as string[],
}));

vi.mock("@/lib/email/marketing", () => ({
  isMarketingSuppressed: async () => false,
  sendMarketingEmail: async (input: Record<string, unknown>) => {
    state.sends.push(String(input.templateKey));
    return { success: true, providerMessageId: "msg" };
  },
}));

vi.mock("@/lib/email/frequency", () => ({
  claimMarketingSend: async () => ({ outcome: "claimed", logId: "log-1" }),
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async () => ([{ slug: "bpc-157", name: "BPC-157 5mg", price: "59.99", image: null }]),
  getStockLevelsBySlugs: async () => new Map(),
}));

vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({ t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true, discountPercent: 5, tiers: [] }),
  getShippingConfig: async () => ({}),
}));

const CART = { id: "cart-1", email: "shopper@example.com", customer_name: "Sam", items: [{ slug: "bpc-157", name: "BPC-157 5mg", quantity: 1, unitPrice: 59.99 }], cart_value_cents: 5999 };

vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "update", "insert", "gte", "lte", "not"]) self[m] = () => self;
    self.maybeSingle = async () => ({
      data: table === "abandoned_carts"
        ? CART
        : table === "abandoned_cart_emails" && state.lastStageSentAt
          ? { sent_at: state.lastStageSentAt }
          : null,
      error: null,
    });
    self.single = async () => ({ data: { id: "row-1" }, error: null });
    self.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
    return self;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});

beforeEach(() => {
  state.lastStageSentAt = null;
  state.sends = [];
  vi.clearAllMocks();
});

describe("the operator resend and the minimum gap between stages", () => {
  it("refuses a resend while the cart's previous stage went less than the gap ago, and mails nothing", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");
    state.lastStageSentAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const result = await resendCartRecoveryEmail("cart-1", "t30m") as { success: boolean; deferred?: boolean; error?: string; retryAt?: number };
    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.error).toMatch(/gap|previous stage|hours/i);
    expect(result.retryAt).toBeGreaterThan(Date.now());
    expect(state.sends).toHaveLength(0);
  });

  it("sends once the gap has passed", async () => {
    const { resendCartRecoveryEmail } = await import("@/lib/admin-cart-recovery");
    state.lastStageSentAt = new Date(Date.now() - 9 * 3_600_000).toISOString();
    const result = await resendCartRecoveryEmail("cart-1", "t30m") as { success: boolean };
    expect(result.success).toBe(true);
    expect(state.sends).toEqual(["cartRecoveryT30mTemplate"]);
  });
});
