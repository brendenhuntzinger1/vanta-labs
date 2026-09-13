import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// P0-1. A DEFERRED SEND MUST NOT MINT, AND REPEATED SWEEPS MUST NOT CHURN.
//
// Issuing a recovery entitlement is not an idempotent read — it RETIRES the
// address's previous unredeemed row and mints a new token. So a mint that runs
// without winning the stage claim is not a harmless retry; it is a revocation
// of a link that may already be sitting in the customer's inbox.
//
// The t72h stage used to mint in the caller, BEFORE reserveAndSendStage was
// entered, because its gift is a bonus rather than the subject and a failed
// mint must not silence the message. Production, 2026-09-12: the frequency
// guard deferred that send on every tick of the 24-hour window, the caller
// minted anyway on every tick, and each mint revoked the one before it.
//
//   cart c7a9ba24  96 tokens, 95 revoked 'reissued', t72h never sent
//   cart 31692694  97 tokens, 96 revoked 'reissued', t72h never sent
//   cart 60b7044b  97 tokens, 96 revoked 'reissued', t72h never sent
//   cart d27ad30f  97 tokens, 96 revoked 'reissued', t72h never sent
//
// The t24h window is 24h wide and the lifecycle cron runs every 15 minutes:
// 96 ticks, 96-97 tokens. One per tick, exactly.
//
// The first token in each chain was the one already emailed at 24 hours,
// promising a ten-day expiry. It died at about 48 hours, when the churn began.
//
// These tests pin the property that makes all of that impossible: THE MINT
// LIVES BEHIND THE CLAIM. No claim, no mint — however many times the sweep
// runs.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;

interface CartRow {
  id: string; email: string; customer_name: string | null;
  items: Array<{ slug: string; name: string; quantity: number; price: number }>;
  cart_value_cents: number; first_seen_at: string; last_updated_at: string; status: string;
}
interface StageRow { id: string; abandoned_cart_id: string; stage: string; coupon_id: string | null; sent_at: string }

const state: { carts: CartRow[]; stages: StageRow[]; coupons: Array<Record<string, unknown>> } = { carts: [], stages: [], coupons: [] };

/** Every issueResolvedOffer call the sweep makes, in order. */
const mints: Array<{ offerKey: string; referenceId?: string }> = [];
/** What the frequency guard answers. The defect needs "deferred". */
let guardOutcome: "claimed" | "deferred" = "deferred";

const hoisted = vi.hoisted(() => ({
  // Typed on the argument, not just the return, so the assertions below can
  // read the rendered body without casting it back out of `unknown`.
  sendMarketingEmail: vi.fn(async (_input: Record<string, unknown>) => ({ success: true })),
  claimMarketingSend: vi.fn(),
  issueResolvedOffer: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
/** P0-10: what marketingBlockedReason answers. null = the sweep may run. */
let blockedReason: string | null = null;
vi.mock("@/lib/email/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmailRuntimeConfig: async () => ({
    enabled: true, provider: "resend", from: "Vanta <hello@example.test>",
    marketingPostalAddress: "1 Test Street, Testville CA 90000",
  }),
  marketingBlockedReason: () => blockedReason,
}));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: hoisted.sendMarketingEmail,
  isMarketingSuppressed: async () => false,
}));
vi.mock("@/lib/email/frequency", () => ({
  claimMarketingSend: hoisted.claimMarketingSend,
  enqueueDeferredMarketingEmail: async () => true,
  marketingMessageAlreadySent: async () => false,
}));
vi.mock("@/lib/offers/customer-offers", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, issueResolvedOffer: hoisted.issueResolvedOffer };
});
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.map((slug) => ({ slug, name: slug, price_cents: 5999, image: "https://example.test/i.jpg" })),
}));
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({
    t30mEnabled: false, t12hEnabled: false, t24hEnabled: false, t72hEnabled: true,
    discountPercent: 0, couponExpirationHours: 48,
  }),
}));

let stageSeq = 0;

vi.mock("@/lib/supabase-server", () => {
  const matches = (row: Record<string, unknown>, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, col, val]) => {
      const cell = row[col];
      if (op === "eq") return String(cell) === String(val);
      if (op === "gte") return String(cell) >= String(val);
      if (op === "is") return cell === val || (val === null && (cell === null || cell === undefined));
      if (op === "in") return (val as unknown[]).map(String).includes(String(cell));
      if (op === "or") {
        return String(val).split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join("."); const a = row[c];
          if (o === "gte") return String(a ?? "") >= v;
          if (o === "lte") return String(a ?? "") <= v;
          if (o === "is" && v === "null") return a === null || a === undefined;
          if (o === "eq") return String(a) === v;
          return false;
        });
      }
      return true;
    });

  const from = (table: string) => ({
    select() {
      const filters: Array<[string, string, unknown]> = [];
      const rows = () => {
        const source = table === "abandoned_carts" ? state.carts
          : table === "abandoned_cart_emails" ? state.stages
            : table === "coupons" ? state.coupons : [];
        return (source as unknown as Array<Record<string, unknown>>).filter((r) => matches(r, filters)).map((r) => ({ ...r }));
      };
      const b: Record<string, unknown> = {
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
        gte(c: string, v: unknown) { filters.push(["gte", c, v]); return b; },
        or(clauses: string) { filters.push(["or", "", clauses]); return b; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
        in(c: string, v: unknown[]) { filters.push(["in", c, v]); return b; },
        limit() { return b; }, order() { return b; },
        range(f: number, t: number) { return Promise.resolve({ data: rows().slice(f, t + 1), error: null }); },
        async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
        async single() { const r = rows(); return { data: r[0] ?? null, error: r[0] ? null : { code: "PGRST116" } }; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      return b;
    },
    insert(payload: Record<string, unknown>) {
      if (table === "abandoned_cart_emails") {
        const dup = state.stages.find((s) => s.abandoned_cart_id === payload.abandoned_cart_id && s.stage === payload.stage);
        if (dup) return { select: () => ({ async single() { return { data: null, error: { code: "23505" } }; } }) };
        const row = { id: `stg-${++stageSeq}`, ...payload } as unknown as StageRow;
        state.stages.push(row);
        return { select: () => ({ async single() { return { data: { id: row.id }, error: null }; } }) };
      }
      return {
        select: () => ({ async single() { return { data: null, error: null }; } }),
        then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
      };
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
    update(payload: Record<string, unknown>) {
      const apply = (column: string, value: unknown) => {
        if (table === "abandoned_cart_emails") {
          for (const row of state.stages) {
            if ((row as unknown as Record<string, unknown>)[column] === value) Object.assign(row, payload);
          }
        }
        return Promise.resolve({ error: null });
      };
      return { eq: apply, in: (c: string, v: unknown[]) => apply(c, (v ?? [])[0]) };
    },
  });
  return { supabaseAdmin: { from } };
});

import { runAbandonedCartSweep } from "@/lib/cart-recovery";

/** A cart sitting squarely inside the t72h window (72-96h since activity). */
function seedCart(): CartRow {
  const at = new Date(Date.now() - 80 * HOUR_MS).toISOString();
  const cart: CartRow = {
    id: "cart-churn-1", email: "shopper@example.test", customer_name: "Sam",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 2, price: 59.99 }],
    cart_value_cents: 22_997, first_seen_at: at, last_updated_at: at, status: "active",
  };
  state.carts.push(cart);
  return cart;
}

beforeEach(() => {
  state.carts = []; state.stages = []; state.coupons = [];
  mints.length = 0; stageSeq = 0; guardOutcome = "deferred"; blockedReason = null;
  hoisted.sendMarketingEmail.mockClear();
  hoisted.claimMarketingSend.mockReset();
  hoisted.claimMarketingSend.mockImplementation(async () =>
    guardOutcome === "claimed"
      ? { outcome: "claimed", logId: "log-1" }
      : { outcome: "deferred", retryAt: Date.now() + HOUR_MS });
  hoisted.issueResolvedOffer.mockReset();
  hoisted.issueResolvedOffer.mockImplementation(async (input: { offerKey: string; referenceId?: string }) => {
    mints.push({ offerKey: input.offerKey, referenceId: input.referenceId });
    return { token: `tok-${mints.length}`, expiresAt: new Date(Date.now() + 10 * 24 * HOUR_MS).toISOString() };
  });
});

describe("the last-chance stage's gift", () => {
  it("is NOT minted when the frequency guard defers the send", async () => {
    seedCart();
    await runAbandonedCartSweep();

    // The whole defect in one assertion. A deferral means the message did not
    // go; minting anyway revokes a live token for a message nobody received.
    expect(mints).toHaveLength(0);
    expect(hoisted.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it("does not churn entitlements across ninety-six deferred sweeps", async () => {
    seedCart();
    // One per tick for the whole 24-hour t72h window — the exact shape that
    // produced 96-97 rows per cart in production.
    for (let tick = 0; tick < 96; tick += 1) await runAbandonedCartSweep();

    expect(mints).toHaveLength(0);
    expect(state.stages).toHaveLength(0);
  });

  it("mints exactly once when the claim IS won, however many sweeps follow", async () => {
    seedCart();
    guardOutcome = "claimed";

    await runAbandonedCartSweep();
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ referenceId: "cart-churn-1" });
    expect(hoisted.sendMarketingEmail).toHaveBeenCalledTimes(1);

    // The stage row now holds the claim, so every later sweep is a no-op. This
    // is the property that makes the mint at-most-once rather than at-least-once.
    for (let tick = 0; tick < 20; tick += 1) await runAbandonedCartSweep();
    expect(mints).toHaveLength(1);
    expect(hoisted.sendMarketingEmail).toHaveBeenCalledTimes(1);
  });

  it("still sends the last-chance message when the gift cannot be minted", async () => {
    seedCart();
    guardOutcome = "claimed";
    hoisted.issueResolvedOffer.mockImplementation(async () => null);

    await runAbandonedCartSweep();

    // The softness that justified minting outside the claim in the first place
    // is preserved — it is now expressed by the callback's contract instead of
    // by its position, so it costs nothing.
    expect(hoisted.sendMarketingEmail).toHaveBeenCalledTimes(1);
    const body = String(hoisted.sendMarketingEmail.mock.calls[0]?.[0]?.text ?? "");
    expect(body).not.toMatch(/free|at no charge/i);
  });

  it("still sends when minting the gift throws", async () => {
    seedCart();
    guardOutcome = "claimed";
    hoisted.issueResolvedOffer.mockImplementation(async () => { throw new Error("offers table is down"); });

    await runAbandonedCartSweep();
    expect(hoisted.sendMarketingEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// P0-10. THE GATE EVERY OTHER MARKETING SENDER HAD, AND THIS ONE DID NOT.
//
// campaign-sender, automations, marketing-queue and the admin send route all
// ask marketingBlockedReason before doing any work. Cart recovery — the
// store's highest-volume marketing stream — never did, so switching email off
// in Settings stopped everything except the one that sends most, and a blank
// postal address produced commercial email without the address CAN-SPAM
// requires (a rule with no volume exemption and no B2B carve-out).
//
// The gate runs BEFORE the scan, which is the load-bearing part: holding must
// not consume anything, or fixing the setting would cost every cart its window.
// ---------------------------------------------------------------------------
describe("the sweep's email-blocked gate", () => {
  it("sends nothing when email is switched off", async () => {
    seedCart();
    guardOutcome = "claimed";
    blockedReason = "Email sending is turned off in Settings.";

    await runAbandonedCartSweep();

    expect(hoisted.sendMarketingEmail).not.toHaveBeenCalled();
    expect(mints).toHaveLength(0);
  });

  it("sends nothing when the postal address is missing", async () => {
    seedCart();
    guardOutcome = "claimed";
    blockedReason = "A physical postal address is required in Settings before marketing email can be sent (CAN-SPAM).";

    await runAbandonedCartSweep();
    expect(hoisted.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it("consumes NOTHING while held, so the window survives the outage", async () => {
    const cart = seedCart();
    guardOutcome = "claimed";
    blockedReason = "Email sending is turned off in Settings.";

    for (let tick = 0; tick < 10; tick += 1) await runAbandonedCartSweep();

    // No stage claimed, no entitlement minted, no frequency claim taken. The
    // tick after the operator fixes the setting must find the cart exactly
    // where it was.
    expect(state.stages).toHaveLength(0);
    expect(mints).toHaveLength(0);
    expect(hoisted.claimMarketingSend).not.toHaveBeenCalled();

    blockedReason = null;
    await runAbandonedCartSweep();

    expect(hoisted.sendMarketingEmail).toHaveBeenCalledTimes(1);
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0].abandoned_cart_id).toBe(cart.id);
  });
});
