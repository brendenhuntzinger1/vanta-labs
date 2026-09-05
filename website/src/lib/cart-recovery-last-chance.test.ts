import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-05. THE 72-HOUR "LAST CHANCE" EMAIL MUST CARRY A REAL, LIVE COUPON.
//
// The t24h stage mints one recovery coupon per cart. The t72h stage correctly
// declines to mint a second — but instead of LOADING the one it is referring to,
// it invented a placeholder:
//
//   const couponForEmail = coupon ?? {
//     code: "SEE PREVIOUS EMAIL",
//     expiresAt: new Date(now + config.couponExpirationHours * HOUR_MS).toISOString(),
//   };
//
// Two independent defects. The customer was shown the literal string
// "SEE PREVIOUS EMAIL" where a coupon code belongs, and an expiry no row in the
// database held.
//
// And under the SHIPPED DEFAULTS the margin is exactly zero: the t24h and t72h
// stages are 48h apart on a fixed */30 schedule, and couponExpirationHours
// defaults to 48 (admin-control.ts:249), so mint+48h IS the tick that sends the
// final email. The mail promised another 48 hours on a code that was already
// dead — the last push of the sequence, to the highest-intent segment.
//
// The rule these tests hold: EVERY CLAIM IN A RECOVERY EMAIL MUST BE TRUE AT
// SEND TIME. The code must be a code, it must validate, and the stated expiry
// must be the one the database will enforce.
// ---------------------------------------------------------------------------

// vitest.setup.ts stubs @/lib/cart-recovery for the whole suite, so nothing has
// ever executed the real sweep. Opt back in, the way membership-billing-real.test.ts
// does for the same reason.
vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;

interface CartRow {
  id: string;
  email: string;
  customer_name: string | null;
  items: Array<{ slug: string; name: string; quantity: number; price: number }>;
  cart_value_cents: number;
  first_seen_at: string;
  status: string;
}

interface CouponRow {
  id: string;
  code: string;
  discount_type: string;
  discount_value: number;
  ends_at: string;
  assigned_email: string;
  active: boolean;
  source: string;
  created_at: string;
  redemptions_count?: number;
  max_redemptions?: number | null;
}

interface StageRow { id: string; abandoned_cart_id: string; stage: string; coupon_id: string | null; sent_at: string }

const state: { carts: CartRow[]; coupons: CouponRow[]; stages: StageRow[] } = { carts: [], coupons: [], stages: [] };

const sent: Array<{ to: string; campaignType: string; subject: string; html: string; text: string }> = [];

const { sendMarketingEmail } = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(async (input: Record<string, unknown>) => {
    sent.push({
      to: String(input.to), campaignType: String(input.campaignType),
      subject: String(input.subject), html: String(input.html), text: String(input.text),
    });
    return { success: true };
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail,
  // Added by C-06's merge: the sweep now skips suppressed recipients before it
  // does any work. Nobody in this fixture is suppressed.
  isMarketingSuppressed: async () => false,
}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
// Product names come from the catalogue at send time, never from the stored
// snapshot (AUTH-3): the mock answers every slug the fixtures use.
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => slugs.map((slug) => ({ slug, name: slug === "bpc-157" ? "BPC-157" : slug })),
}));

/** The shipped defaults — the configuration the defect actually ships under. */
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({
    t30mEnabled: false, t12hEnabled: false, t24hEnabled: true, t72hEnabled: true,
    discountPercent: 5, couponExpirationHours: 48,
  }),
}));

let couponSeq = 0;
let stageSeq = 0;

vi.mock("@/lib/supabase-server", () => {
  const matches = (row: Record<string, unknown>, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, col, val]) => {
      const cell = row[col];
      if (op === "eq") return String(cell) === String(val);
      if (op === "gte") return String(cell) >= String(val);
      if (op === "or") {
        return String(val).split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          const a = row[c];
          if (o === "gte") return String(a ?? "") >= v;
          if (o === "lte") return String(a ?? "") <= v;
          if (o === "is" && v === "null") return a === null || a === undefined;
          if (o === "eq") return String(a) === v;
          return false;
        });
      }
      if (op === "is") return cell === val;
      if (op === "in") return (val as unknown[]).map(String).includes(String(cell));
      return true;
    });

  const from = (table: string) => ({
    select() {
      const filters: Array<[string, string, unknown]> = [];
      const rows = () => {
        const source = table === "abandoned_carts" ? state.carts
          : table === "coupons" ? state.coupons
            : table === "abandoned_cart_emails" ? state.stages : [];
        return (source as unknown as Array<Record<string, unknown>>).filter((r) => matches(r, filters)).map((r) => ({ ...r }));
      };
      const b: Record<string, unknown> = {
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
        gte(c: string, v: unknown) { filters.push(["gte", c, v]); return b; },
        or(clauses: string) { filters.push(["or", "", clauses]); return b; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
        in(c: string, v: unknown[]) { filters.push(["in", c, v]); return b; },
        limit() { return b; },
        order() { return b; },
        // The cart sweep pages its window instead of reading it whole.
        range(from: number, to: number) {
          return Promise.resolve({ data: rows().slice(from, to + 1), error: null });
        },
        async maybeSingle() { const r = rows(); return { data: r[0] ?? null, error: null }; },
        async single() { const r = rows(); return { data: r[0] ?? null, error: r[0] ? null : { code: "PGRST116" } }; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      return b;
    },
    insert(payload: Record<string, unknown>) {
      if (table === "coupons") {
        const row = { id: `cpn-${++couponSeq}`, ...payload } as unknown as CouponRow;
        state.coupons.push(row);
        const result = { data: { id: row.id }, error: null };
        return {
          select: () => ({ async single() { return result; }, async maybeSingle() { return result; } }),
          then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
        };
      }
      if (table === "abandoned_cart_emails") {
        const duplicate = state.stages.find((s) => s.abandoned_cart_id === payload.abandoned_cart_id && s.stage === payload.stage);
        if (duplicate) {
          return { select: () => ({ async single() { return { data: null, error: { code: "23505" } }; } }) };
        }
        const row = { id: `stg-${++stageSeq}`, ...payload } as unknown as StageRow;
        state.stages.push(row);
        return { select: () => ({ async single() { return { data: { id: row.id }, error: null }; } }) };
      }
      return { select: () => ({ async single() { return { data: null, error: null }; } }), then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r) };
    },
    delete() {
      return {
        eq: (column: string, value: unknown) => {
          if (table === "abandoned_cart_emails") {
            const i = state.stages.findIndex((r) => (r as unknown as Record<string, unknown>)[column] === value);
            if (i >= 0) state.stages.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
    /**
     * Applies the write. reserveAndSendStage claims the slot FIRST and writes
     * `coupon_id` onto the reservation afterwards (C-06's ordering), so a fake
     * that swallowed the update would leave every stage row with a null
     * coupon_id — and resolveLastChanceCoupon would then mint a second code for
     * a cart that already had a live one, which is the exact defect K-05 fixes.
     */
    update(payload: Record<string, unknown>) {
      const apply = (column: string, value: unknown) => {
        if (table === "abandoned_cart_emails") {
          for (const row of state.stages) {
            if ((row as unknown as Record<string, unknown>)[column] === value) {
              Object.assign(row, payload);
            }
          }
        }
        return Promise.resolve({ error: null });
      };
      return { eq: apply, in: (c: string, v: unknown[]) => apply(c, (v ?? [])[0]) };
    },
  });
  return { supabaseAdmin: { from } };
});

function seedCart(ageHours: number): CartRow {
  const cart: CartRow = {
    id: "cart-1", email: "shopper@example.com", customer_name: "Sam",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1, price: 42.99 }],
    cart_value_cents: 4299,
    first_seen_at: new Date(Date.now() - ageHours * HOUR_MS).toISOString(),
    status: "active",
  };
  state.carts.push(cart);
  return cart;
}

const t72 = () => sent.find((s) => s.campaignType === "cart_recovery_t72h");
const t24 = () => sent.find((s) => s.campaignType === "cart_recovery_t24h");

beforeEach(() => {
  state.carts = []; state.coupons = []; state.stages = [];
  sent.length = 0; couponSeq = 0; stageSeq = 0;
  vi.clearAllMocks();
});

describe("the 72h last-chance email", () => {
  it("never renders the placeholder string where a coupon code belongs", async () => {
    // The cart has already had its t24h mail, which is the normal path and the
    // only one the defect hits.
    seedCart(73);
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72();
    expect(mail, "t72h stage should have sent").toBeTruthy();
    expect(mail!.html).not.toContain("SEE PREVIOUS EMAIL");
    expect(mail!.text).not.toContain("SEE PREVIOUS EMAIL");
  });

  it("carries a real SAVE- code that exists in the coupons table", async () => {
    seedCart(73);
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72();
    const match = mail!.text.match(/SAVE-[A-Z0-9]+/);
    expect(match, `no SAVE- code in: ${mail!.text}`).toBeTruthy();
    expect(state.coupons.some((c) => c.code === match![0])).toBe(true);
  });

  it("states an expiry that is still in the future when the mail is sent", async () => {
    seedCart(73);
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const code = t72()!.text.match(/SAVE-[A-Z0-9]+/)![0];
    const coupon = state.coupons.find((c) => c.code === code)!;

    // The database is the authority. src/lib/coupons.ts:157 rejects on
    // `new Date(ends_at).getTime() < now`, so this is the test the customer's
    // checkout will actually run.
    expect(new Date(coupon.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not promise an expiry the database will not honour", async () => {
    seedCart(73);
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72()!;
    const code = mail.text.match(/SAVE-[A-Z0-9]+/)![0];
    const coupon = state.coupons.find((c) => c.code === code)!;

    // The rendered date must be the coupon's own, formatted — not a second,
    // independently-computed instant. Comparing the day is enough to catch the
    // 48-hour fabrication, which is what the defect produced.
    const { formatDisplayDate } = await import("@/lib/format-date");
    const truthful = formatDisplayDate(coupon.ends_at, "datetime")!;
    expect(mail.text).toContain(truthful);
  });

  it("reuses a still-live code minted earlier for the same cart rather than minting a second one", async () => {
    // One cart, one code. A row written by the pre-2026-09-04 sequence (which
    // minted on the 24-hour stage) is re-offered while it is still live, so a
    // cart mid-sequence across the deploy never sees two codes.
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: "cpn-live", sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    state.coupons.push({
      id: "cpn-live", code: "SAVE-LIVE0001", discount_type: "percent", discount_value: 5,
      ends_at: new Date(Date.now() + 12 * HOUR_MS).toISOString(),
      assigned_email: cart.email, active: true, source: "cart_recovery",
      // Minted more than a month ago as far as the discount cooldown is
      // concerned? No — 48h, which is inside the 30-day window. The cooldown is
      // about NEW codes; re-offering the one this cart already holds is not a
      // new code, so the sweep must still send with it.
      created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
    });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    expect(state.coupons).toHaveLength(1);
    expect(t24()).toBeUndefined();
    expect(t72()!.text).toContain("SAVE-LIVE0001");
  });

  it("describes the percentage the re-offered code actually carries, not whatever the setting is today", async () => {
    // The code was minted at 8% (an operator changed the setting since, to 5%).
    // K-05: never describe a coupon that was not read back from the database
    // — and that includes its percentage.
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: "cpn-eight", sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    state.coupons.push({
      id: "cpn-eight", code: "SAVE-EIGHT001", discount_type: "percent", discount_value: 8,
      ends_at: new Date(Date.now() + 12 * HOUR_MS).toISOString(),
      assigned_email: cart.email, active: true, source: "cart_recovery",
      created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
    });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(t72()!.subject).toBe("One last note on your cart, with 8% off");
    expect(t72()!.text).toContain("8% off");
    expect(t72()!.text).not.toContain("5% off");
  });

  it("a code that has already been redeemed is not re-offered, even though it is active and unexpired", async () => {
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: "cpn-spent", sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    state.coupons.push({
      id: "cpn-spent", code: "SAVE-SPENT0001", discount_type: "percent", discount_value: 5,
      ends_at: new Date(Date.now() + 12 * HOUR_MS).toISOString(),
      assigned_email: cart.email, active: true, source: "cart_recovery",
      created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
      redemptions_count: 1, max_redemptions: 1,
    });
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(t72()).toBeDefined();
    expect(t72()!.text).not.toContain("SAVE-SPENT0001");
    // Inside the discount cooldown, so no fresh code either: the note goes without one.
    expect(state.coupons).toHaveLength(1);
  });

  it("the 24-hour message carries no code at all", async () => {
    seedCart(25);
    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();
    expect(t72()).toBeUndefined();
    expect(t24()).toBeTruthy();
    expect(t24()!.text).not.toMatch(/SAVE-/);
    expect(state.coupons).toHaveLength(0);
  });

  it("mints a fresh code when the cart's earlier coupon has expired and the address is outside the discount cooldown", async () => {
    // A dead code must be replaced, not advertised. The earlier code here was
    // minted 31 days ago, so the per-address cooldown (30 days) has passed and
    // a new one may be issued.
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: "cpn-old", sent_at: new Date().toISOString() });
    state.coupons.push({
      id: "cpn-old", code: "SAVE-DEAD0001", discount_type: "percent", discount_value: 5,
      ends_at: new Date(Date.now() - HOUR_MS).toISOString(),   // died an hour ago
      assigned_email: cart.email, active: true, source: "cart_recovery",
      created_at: new Date(Date.now() - 31 * 24 * HOUR_MS).toISOString(),
    });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72()!;
    expect(mail.text).not.toContain("SAVE-DEAD0001");
    const code = mail.text.match(/SAVE-[A-Z0-9]+/)![0];
    const coupon = state.coupons.find((c) => c.code === code)!;
    expect(new Date(coupon.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not replace an expired code issued inside the discount cooldown — the mail goes without one", async () => {
    // Same shape, but the dead code is two days old. A second code inside a
    // month is exactly what taught one July shopper to abandon for discounts,
    // so the last note is sent without an offer instead.
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: "cpn-old", sent_at: new Date().toISOString() });
    state.coupons.push({
      id: "cpn-old", code: "SAVE-DEAD0001", discount_type: "percent", discount_value: 5,
      ends_at: new Date(Date.now() - HOUR_MS).toISOString(),
      assigned_email: cart.email, active: true, source: "cart_recovery",
      created_at: new Date(Date.now() - 49 * HOUR_MS).toISOString(),
    });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72()!;
    expect(mail).toBeTruthy();
    expect(mail.text).not.toMatch(/SAVE-/);
    expect(state.coupons).toHaveLength(1);
  });

  it("still sends the stage when no coupon can be resolved, without inventing one", async () => {
    // Degraded path: the t24h row exists but its coupon is gone (deleted, or the
    // row predates coupon_id being recorded). The mail must go without a coupon
    // block rather than with a fabricated one.
    const cart = seedCart(73);
    state.stages.push({ id: "stg-old", abandoned_cart_id: cart.id, stage: "t24h", coupon_id: null, sent_at: new Date().toISOString() });

    const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
    await runAbandonedCartSweep();

    const mail = t72();
    expect(mail).toBeTruthy();
    expect(mail!.html).not.toContain("SEE PREVIOUS EMAIL");
  });
});
