import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK C / C-06 — a failed or suppressed marketing send must NEVER cause
// repeated coupon minting.
//
// THE DEFECT. cart-recovery.ts minted the recovery coupon BEFORE claiming the
// (cart, stage) slot, and reserveAndSendStage DELETED its reservation when the
// send failed ("so a later sweep pass can retry"). The delete wiped the very
// guard the mint was checking, so every failed send re-armed the stage: a fresh
// SAVE-<hex> coupon row per cart per 30-minute sweep, for up to 96 hours.
//
// "The send failed" is not an edge case. sendMarketingEmail returns
// success:false for a provider outage, a rate limit, a timeout — and for an
// UNSUBSCRIBED recipient, who is returned {success:false, suppressed:true}.
// An unsubscribe therefore created a permanent coupon-generation loop for a
// person who had explicitly opted out.
//
// Production: abandoned_cart_emails shows 3,021 rows ever inserted and 27
// remaining — 2,994 reservation insert-then-delete cycles — and 335 minted
// cart_recovery coupons across 3 addresses.
//
// This file is the verification matrix for the fix: provider failure,
// suppression, retry, repeated cron runs, duplicate/concurrent execution,
// successful send, coupon reuse, and no duplicate customer benefit.
//
// No real email is sent; sendMarketingEmail is mocked and every call recorded.
// ---------------------------------------------------------------------------

const CART_ID = "cart-1";
const SHOPPER = "shopper@example.test";

/** How the provider responds. 'ok' | 'fail' | 'suppressed'. */
let sendMode: "ok" | "fail" | "suppressed" = "fail";

type CartEmailRow = {
  id: string;
  abandoned_cart_id: string;
  stage: string;
  coupon_id: string | null;
};

const db = {
  coupons: [] as Array<Record<string, unknown>>,
  cartEmails: [] as CartEmailRow[],
  nextCartEmailId: 1,
  nextCouponId: 1,
  suppressed: new Set<string>(),
  /** Every reservation row ever deleted, so re-arming is visible. */
  reservationDeletes: 0,
};

const attempted: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: vi.fn(async (input: { to: string }) => {
    attempted.push(input.to);
    if (db.suppressed.has(input.to.trim().toLowerCase())) {
      return { success: false, suppressed: true, error: "Recipient has unsubscribed from marketing emails" };
    }
    if (sendMode === "ok") return { success: true };
    return { success: false, error: "No email provider configured." };
  }),
  isMarketingSuppressed: vi.fn(async (email: string) => db.suppressed.has(email.trim().toLowerCase())),
}));
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({
    enabled: true,
    t30mEnabled: false,
    t12hEnabled: false,
    t24hEnabled: true,
    t72hEnabled: false,
    discountPercent: 5,
    couponExpirationHours: 48,
  }),
}));

/** Age of the seeded cart, in hours. */
let cartAgeHours = 25;

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "abandoned_carts") {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        async gte() {
          return {
            data: [{
              id: CART_ID,
              email: SHOPPER,
              customer_name: "Test Shopper",
              items: [{ productId: "p1", name: "Item", quantity: 1, priceCents: 5000 }],
              cart_value_cents: 5000,
              first_seen_at: new Date(Date.now() - cartAgeHours * 60 * 60 * 1000).toISOString(),
            }],
            error: null,
          };
        },
      };
      return b;
    }

    if (table === "coupons") {
      const b: Record<string, unknown> = {
        insert(payload: Record<string, unknown>) {
          const id = `coupon-${db.nextCouponId++}`;
          db.coupons.push({ id, ...payload });
          const env = { data: { id }, error: null };
          return {
            select: () => ({ async single() { return env; }, async maybeSingle() { return env; } }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
          };
        },
        _id: "",
        select: () => b,
        eq(_c: string, v: string) { (b as { _id: string })._id = v; return b; },
        async maybeSingle() {
          const hit = db.coupons.find((c) => c.id === (b as { _id: string })._id);
          return { data: hit ?? null, error: null };
        },
      };
      return b;
    }

    if (table === "abandoned_cart_emails") {
      const b: Record<string, unknown> = {
        _cartId: "", _stage: "",
        select: () => b,
        eq(column: string, value: string) {
          if (column === "abandoned_cart_id") (b as { _cartId: string })._cartId = value;
          if (column === "stage") (b as { _stage: string })._stage = value;
          return b;
        },
        async maybeSingle() {
          const hit = db.cartEmails.find(
            (r) => r.abandoned_cart_id === (b as { _cartId: string })._cartId
              && r.stage === (b as { _stage: string })._stage,
          );
          return { data: hit ?? null, error: null };
        },
        insert: (payload: { abandoned_cart_id: string; stage: string; coupon_id?: string | null }) => ({
          select: () => ({
            async single() {
              // The unique index idx_abandoned_cart_emails_cart_stage.
              const clash = db.cartEmails.some(
                (r) => r.abandoned_cart_id === payload.abandoned_cart_id && r.stage === payload.stage,
              );
              if (clash) return { data: null, error: { code: "23505", message: "duplicate key" } };
              const row: CartEmailRow = {
                id: `ace-${db.nextCartEmailId++}`,
                abandoned_cart_id: payload.abandoned_cart_id,
                stage: payload.stage,
                coupon_id: payload.coupon_id ?? null,
              };
              db.cartEmails.push(row);
              return { data: { id: row.id }, error: null };
            },
          }),
        }),
        update: (payload: { coupon_id?: string | null }) => ({
          async eq(_c: string, value: string) {
            const row = db.cartEmails.find((r) => r.id === value);
            if (row && payload.coupon_id !== undefined) row.coupon_id = payload.coupon_id;
            return { error: null };
          },
        }),
        delete: () => ({
          async eq(_c: string, value: string) {
            const before = db.cartEmails.length;
            db.cartEmails = db.cartEmails.filter((r) => r.id !== value);
            if (db.cartEmails.length < before) db.reservationDeletes += 1;
            return { error: null };
          },
        }),
      };
      return b;
    }

    throw new Error(`unexpected table ${table}`);
  };
  return { supabaseAdmin: { from } };
});

const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");

function recoveryCoupons() {
  return db.coupons.filter((c) => c.source === "cart_recovery");
}

beforeEach(() => {
  db.coupons = [];
  db.cartEmails = [];
  db.nextCartEmailId = 1;
  db.nextCouponId = 1;
  db.suppressed = new Set();
  db.reservationDeletes = 0;
  attempted.length = 0;
  cartAgeHours = 25;
  sendMode = "fail";
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Successful send — the behaviour that must not regress.
// ---------------------------------------------------------------------------
describe("successful send", () => {
  it("mints exactly one coupon and sends exactly one email", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(1);
    expect(attempted).toEqual([SHOPPER]);
    expect(db.cartEmails).toHaveLength(1);
  });

  it("stays at one coupon however many times the cron runs", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(1);
    expect(attempted).toEqual([SHOPPER]);
  });

  it("links the reservation to the coupon it sent", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();

    expect(db.cartEmails[0].coupon_id).toBe(recoveryCoupons()[0].id);
  });
});

// ---------------------------------------------------------------------------
// 2. Provider failure — the original defect.
// ---------------------------------------------------------------------------
describe("provider failure", () => {
  it("mints at most one coupon no matter how many sweeps run", async () => {
    sendMode = "fail";
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(recoveryCoupons().length).toBeLessThanOrEqual(1);
  });

  it("never deletes the stage reservation, so the stage cannot re-arm", async () => {
    sendMode = "fail";
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(db.reservationDeletes).toBe(0);
    expect(db.cartEmails).toHaveLength(1);
  });

  it("does not re-attempt the send on later sweeps", async () => {
    sendMode = "fail";
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(attempted).toHaveLength(1);
  });

  /** 96h of sweeps at one every 30 minutes: the ~192-attempt scenario. */
  it("survives a full 96-hour outage without accumulating coupons or sends", async () => {
    sendMode = "fail";
    for (let i = 0; i < 192; i++) await runAbandonedCartSweep();

    expect(recoveryCoupons().length).toBeLessThanOrEqual(1);
    expect(attempted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Suppressed / unsubscribed recipient — must be inert, permanently.
// ---------------------------------------------------------------------------
describe("suppressed (unsubscribed) recipient", () => {
  beforeEach(() => {
    db.suppressed.add(SHOPPER);
    sendMode = "ok"; // the provider is healthy; suppression is the only reason to stop
  });

  it("mints NO coupon at all", async () => {
    await runAbandonedCartSweep();
    expect(recoveryCoupons()).toHaveLength(0);
  });

  it("mints no coupon across a full 96 hours of sweeps", async () => {
    for (let i = 0; i < 192; i++) await runAbandonedCartSweep();
    expect(recoveryCoupons()).toHaveLength(0);
  });

  it("never hands the message to the marketing sender", async () => {
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    expect(attempted).toHaveLength(0);
  });

  it("does not churn reservation rows", async () => {
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    expect(db.reservationDeletes).toBe(0);
  });

  /** Re-subscribing must restore normal service, not leave them blocked. */
  it("serves them normally once they re-subscribe", async () => {
    await runAbandonedCartSweep();
    expect(recoveryCoupons()).toHaveLength(0);

    db.suppressed.delete(SHOPPER);
    await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(1);
    expect(attempted).toEqual([SHOPPER]);
  });
});

// ---------------------------------------------------------------------------
// 4. Recovery after an outage, and duplicate execution.
// ---------------------------------------------------------------------------
describe("retry and duplicate execution", () => {
  it("does not mint a second coupon when the provider recovers", async () => {
    sendMode = "fail";
    await runAbandonedCartSweep();
    const afterFailure = recoveryCoupons().length;

    sendMode = "ok";
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(afterFailure);
  });

  it("two overlapping sweeps produce one coupon and one send", async () => {
    sendMode = "ok";
    await Promise.all([runAbandonedCartSweep(), runAbandonedCartSweep()]);

    expect(recoveryCoupons()).toHaveLength(1);
    expect(attempted).toHaveLength(1);
  });

  it("the unique index is what stops the duplicate, not timing", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();
    // A second sweep racing in with the slot already claimed.
    await runAbandonedCartSweep();

    expect(db.cartEmails).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. No duplicate customer benefit.
// ---------------------------------------------------------------------------
describe("no duplicate customer benefit", () => {
  it("one abandoned cart yields at most one recovery discount", async () => {
    sendMode = "ok";
    for (let i = 0; i < 10; i++) await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(1);
  });

  it("a coupon that was minted keeps its terms", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();

    const coupon = recoveryCoupons()[0];
    expect(coupon).toMatchObject({
      discount_type: "percent",
      discount_value: 5,
      max_redemptions: 1,
      redemptions_count: 0,
      active: true,
      source: "cart_recovery",
      assigned_email: SHOPPER,
    });
  });

  it("binds the coupon to the shopper it was minted for", async () => {
    sendMode = "ok";
    await runAbandonedCartSweep();
    expect(recoveryCoupons()[0].assigned_email).toBe(SHOPPER);
  });

  it("never mints for a cart that is too young for the stage", async () => {
    sendMode = "ok";
    cartAgeHours = 2; // below the 24h threshold
    await runAbandonedCartSweep();

    expect(recoveryCoupons()).toHaveLength(0);
    expect(attempted).toHaveLength(0);
  });
});
