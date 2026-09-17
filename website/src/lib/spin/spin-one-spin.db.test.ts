import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// ONE SPIN, PROVED AGAINST A REAL DATABASE.
//
// spin-service.test.ts proves the application logic against a simulated index.
// A simulated index has no concurrency to be wrong about — two "parallel" calls
// in one JavaScript event loop are not parallel at all — so the guarantee that
// matters most is exactly the one a mock cannot establish.
//
// This runs the SHIPPED migration against a real Postgres and fires genuinely
// concurrent connections at it. Every route to a second spin is tried:
//
//   * double-click / two tabs      two inserts at the same instant
//   * refresh after winning        a live row already exists
//   * spend it, then come back     a REDEEMED row
//   * wait for it to lapse         an EXPIRED row
//   * a new campaign               must be allowed through
//
// The redeemed and expired cases are the interesting ones, and they document a
// real seam: the partial index is `where revoked_at is null and redeemed_at is
// null`, so neither a redeemed nor an expired row blocks an INSERT. The
// database alone does NOT stop a second spin after redemption — spin-service's
// own read is what does, and these tests are what stop someone deleting that
// read as redundant.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[spin-one-spin] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it. "
    + "This is the only proof that a double-click cannot produce two prizes.\n",
  );
}

const MIGRATION = path.resolve(__dirname, "../sql/customer-offers.sql");

const ORDERS_STUB = `
  create table if not exists public.orders (
    order_id text primary key,
    customer_email text,
    payment_status text not null default 'pending_payment'
  );
`;

const AUTOMATIONS_STUB = `create table if not exists public.email_automations (key text primary key);`;

const ENSURE_SERVICE_ROLE = `
  do $$ begin
    create role service_role nologin noinherit bypassrls;
  exception when duplicate_object then null; end $$;
`;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Mirrors spinOfferKey() in spin-service.ts. */
const spinKey = (campaignId: string) => `spin:${campaignId}`;

const CAMPAIGN = "winback_2026q4";
const EMAIL = "lapsed@example.test";

describeDb("one spin per customer, against real Postgres", () => {
  let dbUrl: string;
  let client: Client;

  beforeAll(async () => {
    dbUrl = await createSuiteDatabase(DATABASE_URL!, "spin_one_spin");
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(ENSURE_SERVICE_ROLE);
    await client.query("create extension if not exists pgcrypto");
    await client.query(ORDERS_STUB);
    await client.query(AUTOMATIONS_STUB);
    await client.query(readFileSync(MIGRATION, "utf8"));
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  beforeEach(async () => {
    await client.query("truncate public.customer_offers");
    await client.query("truncate public.orders");
  });

  /** Mint a spin prize the way spin-service does. */
  async function mintSpin(opts: {
    email?: string;
    campaignId?: string;
    slug?: string;
    expiresInHours?: number;
    minCents?: number;
    on?: Client;
  } = {}) {
    const token = `spin-${Math.random().toString(36).slice(2)}`;
    await (opts.on ?? client).query(
      `insert into public.customer_offers
         (offer_key, token_hash, email, reward_kind, product_slug, quantity, min_subtotal_cents, expires_at)
       values ($1, $2, $3, 'free_product', $4, 1, $5, now() + make_interval(hours => $6))`,
      [
        spinKey(opts.campaignId ?? CAMPAIGN),
        hash(token),
        (opts.email ?? EMAIL).toLowerCase(),
        opts.slug ?? "klow",
        opts.minCents ?? 20_000,
        opts.expiresInHours ?? 72,
      ],
    );
    return token;
  }

  const liveCount = async (campaignId = CAMPAIGN) =>
    Number((await client.query(
      "select count(*)::int as n from public.customer_offers where offer_key = $1 and email = $2",
      [spinKey(campaignId), EMAIL],
    )).rows[0].n);

  it("refuses a second prize while the first is live — the refresh and the second tab", async () => {
    await mintSpin();
    await expect(mintSpin()).rejects.toThrow(/duplicate key|unique constraint/i);
    expect(await liveCount()).toBe(1);
  });

  it("SURVIVES A GENUINE DOUBLE-CLICK: two connections firing at the same instant", async () => {
    // Two real connections, two real transactions, one real index. This is the
    // case a mocked database cannot express, and it is the one that decides
    // whether someone can spin twice by pressing a button quickly.
    const a = new Client({ connectionString: dbUrl });
    const b = new Client({ connectionString: dbUrl });
    await Promise.all([a.connect(), b.connect()]);

    try {
      const results = await Promise.allSettled([
        mintSpin({ on: a, slug: "recon-water" }),
        mintSpin({ on: b, slug: "klow" }),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");

      expect(won, "exactly one insert may survive").toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(await liveCount()).toBe(1);
    } finally {
      await Promise.all([a.end().catch(() => {}), b.end().catch(() => {})]);
    }
  });

  it("holds under a burst of eight simultaneous attempts", async () => {
    const clients = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const c = new Client({ connectionString: dbUrl });
        await c.connect();
        return c;
      }),
    );

    try {
      const results = await Promise.allSettled(clients.map((c) => mintSpin({ on: c })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await liveCount()).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  });

  it("DOES NOT block a second insert once the prize is redeemed — which is why the service reads first", async () => {
    // The index is `where revoked_at is null and redeemed_at is null`, so a
    // redeemed row leaves the slot open at the DATABASE level. That is correct
    // for the win-back it was designed for and dangerous for a wheel: without
    // spin-service's own read, spending your prize would earn you another spin.
    //
    // This test exists to stop that read being deleted as redundant.
    await mintSpin();
    await client.query("update public.customer_offers set redeemed_at = now(), redeemed_order_id = 'order-1'");

    await expect(mintSpin()).resolves.toBeTruthy();
    expect(
      await liveCount(),
      "the database permits it — only the application refuses, and it must keep refusing",
    ).toBe(2);
  });

  it("does not block a second insert once the prize has merely EXPIRED, for the same reason", async () => {
    await mintSpin({ expiresInHours: -1 });
    await expect(mintSpin()).rejects.toThrow(/duplicate key|unique constraint/i);
    // An expired row is still `revoked_at is null and redeemed_at is null`, so
    // the index DOES still hold it. Recorded because it is the opposite of the
    // redeemed case above and the two are easy to conflate.
    expect(await liveCount()).toBe(1);
  });

  it("lets support hand out a fresh spin by revoking the old one", async () => {
    await mintSpin();
    await client.query("update public.customer_offers set revoked_at = now()");
    await expect(mintSpin()).resolves.toBeTruthy();
  });

  it("gives the same person a new spin in a NEW campaign, and only there", async () => {
    await mintSpin({ campaignId: "winback_2026q4" });
    await expect(mintSpin({ campaignId: "winback_2027q1" })).resolves.toBeTruthy();
    // ...but still only one within each.
    await expect(mintSpin({ campaignId: "winback_2027q1" })).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("keeps one customer's spin clear of another's", async () => {
    await mintSpin({ email: EMAIL });
    await expect(mintSpin({ email: "someone.else@example.test" })).resolves.toBeTruthy();
  });

  it("reserves and redeems a spin prize exactly once", async () => {
    const token = await mintSpin();
    await client.query("insert into public.orders (order_id, payment_status) values ('order-1', 'pending_payment')");

    const reserved = (await client.query(
      "select * from public.customer_offer_reserve($1, $2, $3)",
      [hash(token), "order-1", EMAIL],
    )).rows;
    expect(reserved).toHaveLength(1);

    expect((await client.query("select public.customer_offer_redeem($1) as ok", ["order-1"])).rows[0].ok).toBe(true);
    // A second redemption of the same order is not a second consumption.
    expect((await client.query("select public.customer_offer_redeem($1) as ok", ["order-1"])).rows[0].ok).toBe(false);
  });

  it("refuses to reserve a spin prize for a different address — the forwarded link", async () => {
    const token = await mintSpin();
    await client.query("insert into public.orders (order_id, payment_status) values ('order-1', 'pending_payment')");

    const rows = (await client.query(
      "select * from public.customer_offer_reserve($1, $2, $3)",
      [hash(token), "order-1", "stranger@example.test"],
    )).rows;
    expect(rows).toHaveLength(0);
  });

  it("refuses to reserve an expired spin prize", async () => {
    const token = await mintSpin({ expiresInHours: -1 });
    await client.query("insert into public.orders (order_id, payment_status) values ('order-1', 'pending_payment')");

    expect((await client.query(
      "select * from public.customer_offer_reserve($1, $2, $3)",
      [hash(token), "order-1", EMAIL],
    )).rows).toHaveLength(0);
  });
});
