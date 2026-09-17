import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// SPIN ON A PHONE, BUY ON A LAPTOP.
//
// The prize rides in an httpOnly cookie, so the laptop has nothing. This is the
// path that puts it there, and the rules it has to respect are all about NOT
// breaking something that already works: never re-issue a prize a live checkout
// is pricing, never re-issue one that is spent or expired, and never touch an
// offer this wheel did not mint.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  offer_key: string;
  email: string;
  token_hash: string;
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
  revoked_at: string | null;
  redeemed_at: string | null;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], updates: 0 }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table !== "customer_offers") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq(column: keyof Row, value: unknown) { filters.push((r) => r[column] === value); return chain; },
      is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return chain; },
      async maybeSingle() {
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        return { data: hit[0] ?? null, error: null };
      },
      update(patch: Partial<Row>) {
        const upd: Record<string, unknown> = {
          eq(column: keyof Row, value: unknown) { filters.push((r) => r[column] === value); return upd; },
          is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return upd; },
          then(resolve: (v: unknown) => void) {
            for (const r of db.rows) {
              if (filters.every((f) => f(r))) { Object.assign(r, patch); db.updates += 1; }
            }
            resolve({ error: null });
          },
        };
        return upd;
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

const { claimSpinForAccount } = await import("@/lib/spin/spin-claim");
const { spinOfferKey } = await import("@/lib/spin/spin-service");

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const CAMPAIGN = "winback_2026q4";
const EMAIL = "lapsed@example.test";
const HOUR = 60 * 60 * 1000;

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: "offer-1",
    offer_key: spinOfferKey(CAMPAIGN),
    email: EMAIL,
    token_hash: "the-original-hash",
    reward_kind: "free_product",
    product_slug: "klow",
    percent_off: null,
    expires_at: new Date(NOW + 48 * HOUR).toISOString(),
    reserved_order_id: null,
    reserved_at: null,
    revoked_at: null,
    redeemed_at: null,
    ...overrides,
  };
  db.rows.push(row);
  return row;
}

beforeEach(() => {
  db.rows = [];
  db.updates = 0;
});

describe("claiming a prize on a second device", () => {
  it("hands over a fresh token and the prize that was won", async () => {
    seed();
    const claimed = await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW });

    expect(claimed?.prize.id).toBe("klow");
    expect(claimed?.offerToken).toBeTruthy();
    expect(claimed?.expiresAt).toBe(new Date(NOW + 48 * HOUR).toISOString());
  });

  it("reports the SAVED expiry, so the countdown does not restart on the new device", async () => {
    // The prize was won 24 hours ago. The laptop must be told it has 48 hours
    // left, not a fresh 72.
    seed({ expires_at: new Date(NOW + 48 * HOUR).toISOString() });
    const claimed = await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW });

    const remainingHours = (new Date(claimed!.expiresAt).getTime() - NOW) / HOUR;
    expect(remainingHours).toBe(48);
  });

  it("rotates the stored hash, so exactly one bearer token is ever live", async () => {
    const row = seed();
    await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW });

    expect(row.token_hash).not.toBe("the-original-hash");
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the address case-insensitively", async () => {
    seed();
    const claimed = await claimSpinForAccount({ verifiedEmail: "Lapsed@Example.TEST", campaignId: CAMPAIGN, now: NOW });
    expect(claimed).not.toBeNull();
  });
});

describe("what must never be re-issued", () => {
  it("leaves a prize a live checkout is holding", async () => {
    // Rotating here would invalidate the token that checkout is pricing with,
    // so the customer's own in-flight order would lose the gift between the
    // quote and the charge.
    const row = seed({ reserved_order_id: "order-99", reserved_at: new Date(NOW - 60_000).toISOString() });

    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
    expect(row.token_hash, "the held token must survive untouched").toBe("the-original-hash");
    expect(db.updates).toBe(0);
  });

  it("does re-issue once an abandoned hold has lapsed", async () => {
    seed({ reserved_order_id: "order-99", reserved_at: new Date(NOW - 45 * 60_000).toISOString() });
    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).not.toBeNull();
  });

  it("refuses an expired prize rather than putting it in a cookie the till will reject", async () => {
    seed({ expires_at: new Date(NOW - HOUR).toISOString() });
    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
    expect(db.updates).toBe(0);
  });

  it("refuses a prize that has already been spent", async () => {
    seed({ redeemed_at: new Date(NOW - HOUR).toISOString() });
    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
  });

  it("refuses a revoked prize", async () => {
    seed({ revoked_at: new Date(NOW - HOUR).toISOString() });
    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
  });

  it("will not touch an offer this wheel did not mint", async () => {
    // A live cart-recovery gift under a different key. Claiming it here would
    // quietly change how an existing promotion reaches the customer.
    const row = seed({ offer_key: "cart_recovery_bac_water", product_slug: "kpv" });

    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
    expect(row.token_hash).toBe("the-original-hash");
  });

  it("will not claim across campaigns", async () => {
    seed({ offer_key: spinOfferKey("winback_2026q3") });
    expect(await claimSpinForAccount({ verifiedEmail: EMAIL, campaignId: CAMPAIGN, now: NOW })).toBeNull();
  });

  it("refuses an address that is not one, rather than querying for it", async () => {
    seed();
    for (const bad of ["", "   ", "not-an-address"]) {
      expect(await claimSpinForAccount({ verifiedEmail: bad, campaignId: CAMPAIGN, now: NOW }), bad).toBeNull();
    }
  });
});
