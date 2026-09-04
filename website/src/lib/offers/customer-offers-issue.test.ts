import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT HAPPENS WHEN THE INDEX SAYS "THIS ADDRESS ALREADY HOLDS ONE".
//
// customer-offers.test.ts (under sql/) proves the index against a real
// Postgres. This is the other half: what issueCustomerOffer does with the
// refusal. Three rows can be behind it, and only one of them should stop a
// gift going out:
//
//   expired          -> retire it, mint a fresh token
//   live, unheld     -> the last send lost its token; retire it, mint afresh
//   held by checkout -> leave it alone, hand back nothing (next sweep retries)
//
// Before this, every refusal returned null and the win-back went out reading
// "here is your free GHK-Cu" with nothing behind the button.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = {
  id: string;
  offer_key: string;
  email: string;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
  revoked_at: string | null;
  redeemed_at: string | null;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  inserts: 0,
  /** Simulate a database still on the ORIGINAL index (`where revoked_at is null`). */
  oldIndex: false,
}));

vi.mock("@/lib/supabase-server", () => {
  const live = (row: Row) => row.revoked_at === null && (db.oldIndex || row.redeemed_at === null);
  const from = (table: string) => {
    if (table !== "customer_offers") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const chain: Record<string, unknown> = {
      async insert(values: { offer_key: string; email: string; expires_at: string }) {
        db.inserts += 1;
        // The partial unique index, as the database applies it.
        if (db.rows.some((r) => r.offer_key === values.offer_key && r.email === values.email && live(r))) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        db.rows.push({
          id: `row-${db.rows.length + 1}`,
          offer_key: values.offer_key,
          email: values.email,
          expires_at: values.expires_at,
          reserved_order_id: null,
          reserved_at: null,
          revoked_at: null,
          redeemed_at: null,
        });
        return { error: null };
      },
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
          not(column: keyof Row, op: string, value: null) { if (op === "is") filters.push((r) => r[column] !== value); return upd; },
          then(resolve: (v: unknown) => void) {
            for (const r of db.rows) if (filters.every((f) => f(r))) Object.assign(r, patch);
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

const { issueCustomerOffer } = await import("@/lib/offers/customer-offers");

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const EMAIL = "lapsed@example.test";

function seed(overrides: Partial<Row>): Row {
  const row: Row = {
    id: "row-old",
    offer_key: "winback_60_free_ghkcu",
    email: EMAIL,
    expires_at: new Date(NOW + 10 * 24 * HOUR).toISOString(),
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
  db.inserts = 0;
  db.oldIndex = false;
});

describe("issueCustomerOffer when the address already holds a row", () => {
  it("mints normally when nothing is in the way", async () => {
    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });
    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.rows).toHaveLength(1);
  });

  it("retires an EXPIRED offer and issues a fresh token", async () => {
    const old = seed({ expires_at: new Date(NOW - HOUR).toISOString() });

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued?.token).toBeTruthy();
    expect(old.revoked_at).not.toBeNull();
    expect(db.rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    expect(new Date(issued!.expiresAt).getTime()).toBe(NOW + 30 * 24 * HOUR);
  });

  it("retires a live token the previous send lost, so the retry carries a working one", async () => {
    const lost = seed({});

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued?.token).toBeTruthy();
    expect(lost.revoked_at).not.toBeNull();
    // Exactly one spendable row remains: the one behind the email that goes out.
    expect(db.rows.filter((r) => r.revoked_at === null && r.redeemed_at === null)).toHaveLength(1);
  });

  it("LEAVES A CHECKOUT'S HOLD ALONE and issues nothing this sweep", async () => {
    const held = seed({ reserved_order_id: "order-in-flight", reserved_at: new Date(NOW - 5 * 60 * 1000).toISOString() });

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued).toBeNull();
    expect(held.revoked_at).toBeNull();
    expect(db.rows).toHaveLength(1);
  });

  it("treats a hold older than the checkout window as abandoned", async () => {
    const stale = seed({ reserved_order_id: "order-abandoned", reserved_at: new Date(NOW - 2 * HOUR).toISOString() });

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued?.token).toBeTruthy();
    expect(stale.revoked_at).not.toBeNull();
  });

  it("reissues after a REDEEMED offer even on a database still carrying the original index", async () => {
    // customer-offers.sql narrows the index to unredeemed rows, but this code
    // can reach production before that migration does. The redeemed row is
    // then retired too, which changes nothing about it: every reader refuses a
    // redeemed row before it looks at revoked_at.
    db.oldIndex = true;
    const redeemed = seed({ redeemed_at: new Date(NOW - 20 * 24 * HOUR).toISOString() });

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued?.token).toBeTruthy();
    expect(redeemed.revoked_at).not.toBeNull();
    expect(redeemed.redeemed_at).not.toBeNull();
  });

  it("is per campaign: a live shipping gift does not block a product gift", async () => {
    seed({ offer_key: "winback_60_free_shipping" });

    const issued = await issueCustomerOffer({ offerKey: "winback_60_free_ghkcu", email: EMAIL, now: NOW });

    expect(issued?.token).toBeTruthy();
    expect(db.rows.filter((r) => r.revoked_at === null)).toHaveLength(2);
  });
});
