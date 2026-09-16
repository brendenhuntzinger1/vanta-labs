import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RECOVERY_TIERS } from "@/lib/cart-recovery-tiers";

// ---------------------------------------------------------------------------
// ONE OWNER PER CART, while Omnisend owns marketing.
//
// Omnisend cannot import a sequence's execution state, so a cart that has
// already received an in-house stage must finish in-house — restarting the
// shopper at Omnisend's message one would send them "your cart is saved"
// three messages into a conversation. A cart that has received nothing
// belongs to Omnisend from the moment it is tracked. In legacy-only mode the
// sweep therefore considers ONLY carts with a claimed stage, skips and
// counts every other open cart, and changes nothing about how a legacy cart
// is treated: same windows, same cooldowns, same gaps.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;

type Row = Record<string, unknown>;

const db: { carts: Row[]; stages: Row[]; coupons: Row[]; orders: Row[] } = { carts: [], stages: [], coupons: [], orders: [] };
const sent: Array<{ to: string; campaignType: string }> = [];

const { sendMarketingEmail } = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(async (input: Record<string, unknown>) => {
    sent.push({ to: String(input.to), campaignType: String(input.campaignType) });
    return { success: true };
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => { throw new Error("no request scope in this suite"); } }));
vi.mock("@/lib/email/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmailRuntimeConfig: async () => ({
    enabled: true, provider: "resend", from: "Vanta <hello@example.test>",
    marketingPostalAddress: "1 Test Street, Testville CA 90000",
  }),
  marketingBlockedReason: () => null,
}));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail, isMarketingSuppressed: async () => false }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => slugs.map((slug) => ({ slug, name: slug === "bpc-157" ? "BPC-157" : slug })),
  getStockLevelsBySlugs: async () => new Map(),
}));

const config = {
  t30mEnabled: true, t12hEnabled: false, t24hEnabled: true, t72hEnabled: true,
  discountPercent: 5, couponExpirationHours: 48, tiers: DEFAULT_RECOVERY_TIERS,
};
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => config,
  getShippingConfig: async () => ({}),
}));

let seq = 0;

vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const TABLES: Record<string, keyof typeof db> = { abandoned_carts: "carts", abandoned_cart_emails: "stages", coupons: "coupons", orders: "orders" };
    const rows = () => db[TABLES[table]] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    let take: number | null = null;
    const hits = () => {
      const out = rows().filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      return take === null ? out : out.slice(0, take);
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push((r) => String(r[c]) === String(v)); return b; },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      gt(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.map(String).includes(String(r[c]))); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not() { filters.push(() => false); return b; },
      or(clauses: string) {
        filters.push((r) => clauses.split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          if (o === "gte") return String(r[c] ?? "") >= v;
          return false;
        }));
        return b;
      },
      order() { return b; },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) { return Promise.resolve({ data: hits().slice(from, to + 1), error: null }); },
      maybeSingle() { return Promise.resolve({ data: hits()[0] ?? null, error: null }); },
      single() { const r = hits(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { code: "PGRST116" } }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: hits(), error: null }).then(resolve); },
      insert(payload: Row) {
        if (table === "abandoned_cart_emails") {
          const clash = rows().some((r) => r.abandoned_cart_id === payload.abandoned_cart_id && r.stage === payload.stage);
          const settled = clash
            ? { data: null, error: { code: "23505" } }
            : (() => { const row = { id: `stg-${++seq}`, ...payload }; rows().push(row); return { data: { id: row.id }, error: null }; })();
          return { select: () => ({ single: async () => settled, maybeSingle: async () => settled }) };
        }
        const row = { id: `${table}-${++seq}`, ...payload };
        rows().push(row);
        const settled = { data: { id: row.id }, error: null };
        return {
          select: () => ({ single: async () => settled, maybeSingle: async () => settled }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
      },
      update(payload: Row) {
        const where: Array<(row: Row) => boolean> = [];
        const u: Record<string, unknown> = {
          eq(c: string, v: unknown) { where.push((r) => String(r[c]) === String(v)); return u; },
          in(c: string, v: unknown[]) { where.push((r) => v.map(String).includes(String(r[c]))); return u; },
          is(c: string, v: unknown) { where.push((r) => (r[c] ?? null) === v); return u; },
          then(resolve: (v: unknown) => unknown) {
            for (const row of rows()) if (where.every((f) => f(row))) Object.assign(row, payload);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return u;
      },
      delete() {
        return { eq(c: string, v: unknown) { const keep = rows().filter((r) => r[c] !== v); rows().length = 0; rows().push(...keep); return Promise.resolve({ error: null }); } };
      },
    };
    return b;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});

function seedCart(input: { id: string; email?: string; hoursAgo: number }): Row {
  const cart: Row = {
    id: input.id,
    email: input.email ?? `${input.id}@example.com`,
    customer_name: "Sam",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1, price: 42.99 }],
    cart_value_cents: 14999,
    first_seen_at: new Date(Date.now() - input.hoursAgo * HOUR_MS).toISOString(),
    last_updated_at: new Date(Date.now() - input.hoursAgo * HOUR_MS).toISOString(),
    status: "active",
  };
  db.carts.push(cart);
  return cart;
}

function claimStage(cartId: string, stage: string, hoursAgo: number) {
  db.stages.push({ id: `stg-${++seq}`, abandoned_cart_id: cartId, stage, coupon_id: null, sent_at: new Date(Date.now() - hoursAgo * HOUR_MS).toISOString() });
}

beforeEach(() => {
  db.carts = []; db.stages = []; db.coupons = []; db.orders = [];
  sent.length = 0; seq = 0;
  vi.clearAllMocks();
});

describe("runAbandonedCartSweep({ legacyOnly: true })", () => {
  it("finishes a cart that already has a stage and skips one that has none, counting it as Omnisend's", async () => {
    // Legacy: stage 1 went 24 hours ago, so stage 3 (t24h) is due now.
    seedCart({ id: "legacy", hoursAgo: 25 });
    claimStage("legacy", "t30m", 24);
    // Omnisend's: 25 hours old, nothing sent — in-house it would get t24h too.
    seedCart({ id: "fresh", hoursAgo: 25 });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep({ legacyOnly: true });

    expect(sent.map((s) => [s.to, s.campaignType])).toEqual([["legacy@example.com", "cart_recovery_t24h"]]);
    expect(result.omnisendOwned).toBe(1);
    expect(result.t24hSent).toBe(1);
    expect(result.eligible).toBe(1);
    expect(db.stages.filter((row) => row.abandoned_cart_id === "fresh")).toHaveLength(0);
  });

  it("does not close, hold or count an Omnisend-owned cart in any other way", async () => {
    const fresh = seedCart({ id: "fresh", hoursAgo: 2 });
    db.orders.push({ order_id: "o-1", customer_email: fresh.email, payment_status: "paid", created_at: new Date(Date.now() - HOUR_MS).toISOString() });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep({ legacyOnly: true });

    expect(result).toMatchObject({ omnisendOwned: 1, recoveredLate: 0, heldForCooldown: 0, eligible: 0 });
    expect(fresh.status).toBe("active");
    expect(sent).toHaveLength(0);
  });

  it("keeps every rule for a legacy cart: the minimum gap still holds a stage whose window is open", async () => {
    // Stage 1 went only two hours ago; t24h's window is open (25h) but the
    // eight-hour floor between stages holds it, exactly as in the full sweep.
    seedCart({ id: "legacy", hoursAgo: 25 });
    claimStage("legacy", "t30m", 2);

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep({ legacyOnly: true });

    expect(sent).toHaveLength(0);
    expect(result.eligible).toBe(0);
    expect(result.omnisendOwned).toBe(0);
  });

  it("is the default-off: a plain call still starts new sequences and reports zero Omnisend-owned carts", async () => {
    seedCart({ id: "fresh", hoursAgo: 2 });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep();

    expect(sent.map((s) => s.campaignType)).toEqual(["cart_recovery_t30m"]);
    expect(result.omnisendOwned).toBe(0);
  });
});
