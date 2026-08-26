import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK C / C-06 — a failed send mints a fresh live coupon every 30 minutes.
//
// cart-recovery.ts already carries a fix for minting-per-sweep:
//
//     // Mint a coupon only if this cart hasn't already had its t24h email — the
//     // sweep runs repeatedly, so minting before the send-dedup check (as this
//     // did) re-created a fresh SAVE-… code on every pass ... means each
//     // forgotten cart gets exactly one recovery code.
//
// The guard reads abandoned_cart_emails. reserveAndSendStage DELETES its
// reservation row when the send fails ("so a later sweep pass can retry"). So
// whenever the send fails the guard is empty again on the next pass — and the
// mint happens BEFORE the reservation. Email is DISABLED BY DEFAULT and the noop
// provider reports success:false, so "the send fails" is the app's out-of-the-box
// state, not an edge case.
//
// Each orphan is a real row in `coupons`: active, percent-off, max_redemptions 1,
// assigned_email set. They are redeemable.
//
// No real email is sent; sendMarketingEmail is mocked.
// ---------------------------------------------------------------------------

const CART_ID = "cart-1";
const SHOPPER = "shopper@example.test";

/** false = the noop provider / a provider outage. */
let sendSucceeds = false;

const db = {
  coupons: [] as Array<Record<string, unknown>>,
  cartEmails: [] as Array<{ id: number; abandoned_cart_id: string; stage: string }>,
  nextCartEmailId: 1,
};

// vitest.setup.ts stubs @/lib/cart-recovery globally — runAbandonedCartSweep is
// replaced with `async () => ({ t30mSent: 0, ... })` for EVERY suite in the
// repo. Without this line the sweep under test never runs and this file passes
// against a function that does nothing. See finding C-07.
vi.unmock("@/lib/cart-recovery");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: vi.fn(async () => (sendSucceeds ? { success: true } : { success: false, error: "No email provider configured." })),
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

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "abandoned_carts") {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        async gte() {
          return {
            data: [
              {
                id: CART_ID,
                email: SHOPPER,
                customer_name: "Test Shopper",
                items: [{ productId: "p1", name: "Item", quantity: 1, priceCents: 5000 }],
                cart_value_cents: 5000,
                // 25 hours ago: the t24h stage is due.
                first_seen_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
              },
            ],
            error: null,
          };
        },
      };
      return b;
    }

    if (table === "coupons") {
      return {
        async insert(payload: Record<string, unknown>) {
          db.coupons.push(payload);
          return { error: null };
        },
      };
    }

    if (table === "abandoned_cart_emails") {
      const b: Record<string, unknown> = {
        select: () => b,
        _cartId: "",
        _stage: "",
        eq(column: string, value: string) {
          if (column === "abandoned_cart_id") (b as { _cartId: string })._cartId = value;
          if (column === "stage") (b as { _stage: string })._stage = value;
          return b;
        },
        async maybeSingle() {
          const hit = db.cartEmails.find(
            (r) => r.abandoned_cart_id === (b as { _cartId: string })._cartId && r.stage === (b as { _stage: string })._stage,
          );
          return { data: hit ? { id: hit.id } : null, error: null };
        },
        insert: (payload: { abandoned_cart_id: string; stage: string }) => ({
          select: () => ({
            async single() {
              const clash = db.cartEmails.some(
                (r) => r.abandoned_cart_id === payload.abandoned_cart_id && r.stage === payload.stage,
              );
              if (clash) return { data: null, error: { code: "23505", message: "duplicate key" } };
              const row = { id: db.nextCartEmailId++, abandoned_cart_id: payload.abandoned_cart_id, stage: payload.stage };
              db.cartEmails.push(row);
              return { data: { id: row.id }, error: null };
            },
          }),
        }),
        delete: () => ({
          async eq(_column: string, value: number) {
            db.cartEmails = db.cartEmails.filter((r) => r.id !== value);
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

beforeEach(() => {
  db.coupons = [];
  db.cartEmails = [];
  db.nextCartEmailId = 1;
  vi.clearAllMocks();
});

describe("when the provider is working", () => {
  it("mints exactly one recovery coupon however often the sweep runs", async () => {
    sendSucceeds = true;

    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    expect(db.coupons).toHaveLength(1);
    expect(db.cartEmails).toHaveLength(1);
  });
});

describe("when the send fails — the default, since email ships disabled", () => {
  it("still mints exactly one recovery coupon", async () => {
    sendSucceeds = false;

    // Three cron ticks: 90 minutes of a cart sitting abandoned with email off.
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    // The reservation is rolled back each time, so hasSentStage never sees it
    // and the mint above it runs again on every pass.
    expect(db.coupons).toHaveLength(1);
  });

  it("does not leave live redeemable coupons behind for a cart that got no email", async () => {
    sendSucceeds = false;
    await runAbandonedCartSweep();
    await runAbandonedCartSweep();

    const live = db.coupons.filter((c) => c.active === true && c.source === "cart_recovery");
    expect(live).toHaveLength(1);
    expect(db.cartEmails).toHaveLength(0); // nothing was ever delivered
  });
});
