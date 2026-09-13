import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// P0-1 BACKSTOP. REISSUING IS A REVOCATION, SO IT HAS TO BE BOUNDED.
//
// issueResolvedOffer answers the one-live-offer index by retiring the blocking
// row and minting a fresh token. That is right once — "the link in the NEWEST
// email is the one that works" — and indefensible on a loop, because every
// reissue kills a link that may already be in somebody's inbox.
//
// In production a caller re-entered on every 15-minute tick and turned this
// into 96 revocations for a single cart, while the token the shopper had
// actually been emailed died two days into a ten-day promise.
//
// That caller is fixed at the cause (cart-recovery.ts now mints behind its
// stage claim). This is the backstop: whatever the caller does, one logical
// issuance cannot mint an unbounded number of tokens. It is deliberately loose
// — honest paths make one or two rows — so it can only ever catch a loop.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log-redaction", () => ({ redactEmailForLog: (e: string) => e }));

type Row = {
  id: string;
  offer_key: string;
  email: string;
  reference_id: string | null;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
  revoked_at: string | null;
  redeemed_at: string | null;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], inserts: 0, countError: false }));

vi.mock("@/lib/supabase-server", () => {
  const live = (row: Row) => row.revoked_at === null && row.redeemed_at === null;
  const from = (table: string) => {
    if (table !== "customer_offers") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let headCount = false;
    const chain: Record<string, unknown> = {
      async insert(values: Record<string, unknown>) {
        db.inserts += 1;
        if (db.rows.some((r) => r.offer_key === values.offer_key && r.email === values.email && live(r))) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        db.rows.push({
          id: `row-${db.rows.length + 1}`,
          offer_key: String(values.offer_key),
          email: String(values.email),
          reference_id: values.reference_id === undefined ? null : String(values.reference_id),
          expires_at: String(values.expires_at),
          reserved_order_id: null, reserved_at: null, revoked_at: null, redeemed_at: null,
        });
        return { error: null };
      },
      select(_cols?: unknown, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) headCount = true;
        return chain;
      },
      eq(column: keyof Row, value: unknown) { filters.push((r) => String(r[column]) === String(value)); return chain; },
      is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return chain; },
      // The real call chains .eq().is().is() and only then awaits, so the fake
      // has to be chainable AND thenable rather than resolving at the first .eq.
      update(patch: Partial<Row>) {
        const preds: Array<(row: Row) => boolean> = [];
        const u: Record<string, unknown> = {
          eq(column: keyof Row, value: unknown) { preds.push((r) => String(r[column]) === String(value)); return u; },
          is(column: keyof Row, value: null) { preds.push((r) => r[column] === value); return u; },
          then(resolve: (v: { error: null }) => unknown) {
            for (const row of db.rows) if (preds.every((p) => p(row))) Object.assign(row, patch);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return u;
      },
      async maybeSingle() {
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        return { data: hit[0] ?? null, error: null };
      },
      // The head+count form the reissue budget uses.
      then(resolve: (v: { count: number | null; error: unknown; data: unknown }) => unknown) {
        if (db.countError) return Promise.resolve({ count: null, error: { message: "read failed" }, data: null }).then(resolve);
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve(headCount ? { count: hit.length, error: null, data: null } : { count: null, error: null, data: hit }).then(resolve);
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

import { issueResolvedOffer } from "@/lib/offers/customer-offers";

const CONFIG = {
  label: "GHK-Cu 50mg",
  reward: { kind: "free_products" as const, items: [{ slug: "ghk-cu", quantity: 1, variantId: null }] },
  minSubtotalCents: 25_000,
  ttlDays: 10,
};

const EMAIL = "shopper@example.test";
const KEY = "cart_recovery_bac_water";
const REF = "cart-1";

function seed(count: number, opts: { lastIsLive: boolean }) {
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    db.rows.push({
      id: `seed-${i}`, offer_key: KEY, email: EMAIL, reference_id: REF,
      expires_at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      reserved_order_id: null, reserved_at: null,
      revoked_at: isLast && opts.lastIsLive ? null : new Date().toISOString(),
      redeemed_at: null,
    });
  }
}

beforeEach(() => { db.rows = []; db.inserts = 0; db.countError = false; });

describe("the reissue budget", () => {
  it("still reissues at the second token, which is the honest retry", async () => {
    // One earlier row, live and unheld: the classic "the send failed and the
    // token was never stored" case the retire-and-remint exists for.
    seed(1, { lastIsLive: true });
    const issued = await issueResolvedOffer({ offerKey: KEY, config: CONFIG, email: EMAIL, referenceId: REF });
    expect(issued).not.toBeNull();
    expect(db.rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  it("refuses once one reference has already produced three tokens", async () => {
    seed(3, { lastIsLive: true });
    const issued = await issueResolvedOffer({ offerKey: KEY, config: CONFIG, email: EMAIL, referenceId: REF });

    // Nothing minted, and — the point — the live row is NOT revoked. A loop
    // must not keep killing the link the customer already has.
    expect(issued).toBeNull();
    expect(db.rows).toHaveLength(3);
    expect(db.rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  it("counts revoked rows, because the revoked rows ARE the churn", async () => {
    // Two already-revoked plus one live: exactly the shape the production
    // churn made. Excluding revoked rows would make the guard blind to it.
    seed(3, { lastIsLive: true });
    expect(db.rows.filter((r) => r.revoked_at !== null)).toHaveLength(2);
    const issued = await issueResolvedOffer({ offerKey: KEY, config: CONFIG, email: EMAIL, referenceId: REF });
    expect(issued).toBeNull();
  });

  it("does not bound an issuance that carries no reference", async () => {
    // Campaign and win-back gifts key on the address alone. They cannot loop
    // on a reference, so the budget must not apply and quietly starve them.
    for (let i = 0; i < 5; i += 1) {
      db.rows.push({
        id: `noref-${i}`, offer_key: KEY, email: EMAIL, reference_id: null,
        expires_at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        reserved_order_id: null, reserved_at: null,
        revoked_at: i === 4 ? null : new Date().toISOString(), redeemed_at: null,
      });
    }
    const issued = await issueResolvedOffer({ offerKey: KEY, config: CONFIG, email: EMAIL });
    expect(issued).not.toBeNull();
  });

  it("fails OPEN when the count cannot be read", async () => {
    // Opposite direction from suppression, deliberately: refusing here
    // withholds a gift the customer was promised, while allowing risks one
    // extra row that the next count stops. The cheaper mistake is the row.
    seed(3, { lastIsLive: true });
    db.countError = true;
    const issued = await issueResolvedOffer({ offerKey: KEY, config: CONFIG, email: EMAIL, referenceId: REF });
    expect(issued).not.toBeNull();
  });
});
