import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE RECOVERY SEQUENCE IS A SEQUENCE, NOT A BACKLOG.
//
// Production, cart c1bb28a8 (2026-07-21): t24h and t12h were sent in the SAME
// MINUTE, because every stage whose delay had elapsed was "due" and the sweep
// sent all of them. Cart e7a0adde received its t12h 39 days after its t72h.
// One shopper started four carts in nine days and was handed four discount
// codes, then placed five full-price orders — the codes were training, not
// recovery.
//
// The rules this file holds:
//   * each stage has a WINDOW; a stage whose window has passed is skipped, not
//     caught up, so a cart is mailed at most once per sweep and never for a
//     stage that is stale;
//   * the clock runs from the shopper's LAST activity, not their first;
//   * a paid order after the cart was seen ends the sequence even if the
//     payment webhook's own mark was missed;
//   * one sequence per address per seven days;
//   * the discount is offered once per address per thirty days, and never to
//     someone who bought in the last thirty days.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type Row = Record<string, unknown>;

const db: { carts: Row[]; stages: Row[]; coupons: Row[]; orders: Row[] } = { carts: [], stages: [], coupons: [], orders: [] };
const sent: Array<{ to: string; campaignType: string; subject: string; text: string; html: string }> = [];

const { sendMarketingEmail } = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(async (input: Record<string, unknown>) => {
    sent.push({
      to: String(input.to), campaignType: String(input.campaignType),
      subject: String(input.subject), text: String(input.text), html: String(input.html),
    });
    return { success: true };
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail, isMarketingSuppressed: async () => false }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

const config = {
  t30mEnabled: true, t12hEnabled: false, t24hEnabled: true, t72hEnabled: true,
  discountPercent: 5, couponExpirationHours: 48,
};
vi.mock("@/lib/admin-control", () => ({ getCartRecoveryControlConfig: async () => config }));

let seq = 0;

// PostgREST-shaped, honouring the filters the sweep actually uses.
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
      or(clauses: string) {
        filters.push((r) => clauses.split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          if (o === "gte") return String(r[c] ?? "") >= v;
          if (o === "lte") return String(r[c] ?? "") <= v;
          if (o === "is" && v === "null") return r[c] === null || r[c] === undefined;
          if (o === "eq") return String(r[c]) === v;
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

function seedCart(input: { id?: string; email?: string; firstSeenHoursAgo: number; lastUpdatedHoursAgo?: number; value?: number }): Row {
  const cart: Row = {
    id: input.id ?? `cart-${++seq}`,
    email: input.email ?? "shopper@example.com",
    customer_name: "Sam",
    items: [{ name: "BPC-157", quantity: 1, price: 42.99 }],
    cart_value_cents: input.value ?? 4299,
    first_seen_at: new Date(Date.now() - input.firstSeenHoursAgo * HOUR_MS).toISOString(),
    last_updated_at: new Date(Date.now() - (input.lastUpdatedHoursAgo ?? input.firstSeenHoursAgo) * HOUR_MS).toISOString(),
    status: "active",
  };
  db.carts.push(cart);
  return cart;
}

beforeEach(() => {
  db.carts = []; db.stages = []; db.coupons = []; db.orders = [];
  sent.length = 0; seq = 0;
  config.t12hEnabled = false; config.discountPercent = 5;
  vi.clearAllMocks();
});

describe("selectDueStage", () => {
  it("picks the one stage whose window contains now, and never catches up", async () => {
    const { selectDueStage } = await import("@/lib/cart-recovery");
    const none = new Set<string>();
    expect(selectDueStage(2 * HOUR_MS, config, none)).toBe("t30m");
    expect(selectDueStage(30 * 60_000, config, none)).toBeNull();            // too young
    expect(selectDueStage(13 * HOUR_MS, config, none)).toBeNull();           // t12h off, t30m window closed
    expect(selectDueStage(13 * HOUR_MS, { ...config, t12hEnabled: true }, none)).toBe("t12h");
    expect(selectDueStage(25 * HOUR_MS, config, none)).toBe("t24h");         // t30m is stale, not due
    expect(selectDueStage(73 * HOUR_MS, config, none)).toBe("t72h");
    expect(selectDueStage(100 * HOUR_MS, config, none)).toBeNull();          // sequence over
    expect(selectDueStage(30 * HOUR_MS, config, new Set(["t24h"]))).toBeNull();
  });
});

describe("the sweep", () => {
  it("sends only the current stage for a cart first seen 73 hours ago", async () => {
    seedCart({ firstSeenHoursAgo: 73 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep();
    expect(sent.map((s) => s.campaignType)).toEqual(["cart_recovery_t72h"]);
    expect(result.t24hSent).toBe(0);
    expect(result.t72hSent).toBe(1);
  });

  it("measures the delay from the shopper's last activity, not their first visit", async () => {
    seedCart({ firstSeenHoursAgo: 3, lastUpdatedHoursAgo: 0.2 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent).toHaveLength(0);
  });

  it("ends the sequence when the shopper has paid since the cart was seen, even if the webhook mark was missed", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 2 });
    db.orders.push({ order_id: "o-1", customer_email: cart.email, payment_status: "paid", created_at: new Date(Date.now() - HOUR_MS).toISOString() });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent).toHaveLength(0);
    expect(cart.status).toBe("recovered");
    expect(cart.recovered_order_id).toBe("o-1");
  });

  it("a cart edited late still gets its 72-hour message: the clock AND the age-out both run from the last activity", async () => {
    // First seen five days ago, last touched 73 hours ago. Bounding the scan by
    // first_seen_at dropped this cart at 96 hours from first sight, so the
    // most engaged carts were exactly the ones that never received the last
    // note — the only one that carries the discount.
    seedCart({ firstSeenHoursAgo: 122, lastUpdatedHoursAgo: 73 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent.map((s) => s.campaignType)).toEqual(["cart_recovery_t72h"]);
  });

  it("a second cart inside the week starts its sequence when the cooldown ends, instead of never", async () => {
    // The last recovery email to this address went 7 days and 2 hours ago,
    // about another cart. The new cart was started an hour before that
    // cooldown expired. Holding the CART meant it aged out unmailed; holding
    // the SEQUENCE means its first reminder is due now, two hours into a
    // clock that started when the week was up.
    const earlier = seedCart({ id: "cart-old", firstSeenHoursAgo: 12 * 24 });
    db.stages.push({ id: "stg-old", abandoned_cart_id: earlier.id, stage: "t72h", coupon_id: null, sent_at: new Date(Date.now() - 7 * DAY_MS - 2 * HOUR_MS).toISOString() });
    seedCart({ id: "cart-new", firstSeenHoursAgo: 7 * 24 + 1 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep();
    expect(sent.map((s) => s.campaignType)).toEqual(["cart_recovery_t30m"]);
    expect(result.heldForCooldown).toBe(0);
  });

  it("does not start a second sequence for an address mailed about another cart in the last seven days", async () => {
    const earlier = seedCart({ id: "cart-old", firstSeenHoursAgo: 80 });
    db.stages.push({ id: "stg-old", abandoned_cart_id: earlier.id, stage: "t72h", coupon_id: null, sent_at: new Date(Date.now() - 2 * DAY_MS).toISOString() });
    seedCart({ id: "cart-new", firstSeenHoursAgo: 2 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    const result = await runAbandonedCartSweep();
    expect(sent).toHaveLength(0);
    expect(result.heldForCooldown).toBe(1);
  });

  it("continues a sequence already under way for the same cart", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 25 });
    db.stages.push({ id: "stg-1", abandoned_cart_id: cart.id, stage: "t30m", coupon_id: null, sent_at: new Date(Date.now() - 23 * HOUR_MS).toISOString() });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent.map((s) => s.campaignType)).toEqual(["cart_recovery_t24h"]);
  });

  it("offers the discount on the final stage only", async () => {
    seedCart({ firstSeenHoursAgo: 25 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent[0].campaignType).toBe("cart_recovery_t24h");
    expect(sent[0].text).not.toMatch(/SAVE-/);
    expect(db.coupons).toHaveLength(0);
  });

  it("withholds the discount when this address was given a recovery code in the last thirty days, but still sends", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 73 });
    db.coupons.push({ id: "cpn-recent", code: "SAVE-RECENT01", assigned_email: cart.email, source: "cart_recovery", active: true, created_at: new Date(Date.now() - 10 * DAY_MS).toISOString(), ends_at: new Date(Date.now() - 8 * DAY_MS).toISOString() });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent).toHaveLength(1);
    expect(sent[0].campaignType).toBe("cart_recovery_t72h");
    expect(sent[0].text).not.toMatch(/SAVE-/);
    expect(db.coupons).toHaveLength(1);
  });

  it("withholds the discount from someone who bought in the last thirty days", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 73 });
    db.orders.push({ order_id: "o-old", customer_email: cart.email, payment_status: "paid", created_at: new Date(Date.now() - 10 * DAY_MS).toISOString() });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toMatch(/SAVE-/);
    expect(db.coupons).toHaveLength(0);
  });

  it("offers the discount to a first-time abandoner on the final stage", async () => {
    seedCart({ firstSeenHoursAgo: 73 });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(sent[0].text).toMatch(/SAVE-[A-Z0-9]+/);
    expect(sent[0].text).toContain("5%");
    expect(db.coupons).toHaveLength(1);
  });
});

describe("clearing a cart", () => {
  it("retires the active row so no further stage can be sent", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 2 });
    cart.session_id = "sess-1";
    const { clearAbandonedCart, runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await clearAbandonedCart("sess-1");
    expect(cart.status).toBe("cleared");
    await runAbandonedCartSweep();
    expect(sent).toHaveLength(0);
  });
});
