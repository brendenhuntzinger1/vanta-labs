import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE CONCURRENCY PROOF.
//
// bxgy-checkout.test.ts records the old behaviour honestly — "TWO SIMULTANEOUS
// CHECKOUTS CAN BOTH TAKE THE LAST REDEMPTION" — because with a SELECT and an
// INSERT and no lock between them, they could. No amount of mocking can prove
// the fix: a mocked database has no concurrency to be wrong about, and a test
// that awaits two promises in sequence proves only that sequence works.
//
// So this runs the SHIPPED function, parsed out of the migration file that
// actually deploys, against a real Postgres, from N genuinely parallel client
// connections firing at the same instant. If the advisory lock were removed
// these tests fail — verified by removing it.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  // stderr, not console.warn: vitest swallows console output for a skipped
  // module, which is how a dead proof reports success.
  process.stderr.write(
    "[bxgy-redemption-claims] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const MIGRATION = path.resolve(__dirname, "bxgy-redemption-claims.sql");

/** Just enough of `orders` for the claim function's status checks to resolve. */
const ORDERS_STUB = `
  create table if not exists public.orders (
    order_id text primary key,
    customer_email text,
    payment_status text not null default 'pending_payment'
  );
`;

/** Roles are cluster-wide, so creating one is not per-database and can collide. */
const ENSURE_SERVICE_ROLE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role;
    end if;
  end $$;
`;

describeDb("bxgy_claim_redemption enforces limits atomically", () => {
  let url: string;
  let db: Client;

  beforeAll(async () => {
    url = await createSuiteDatabase(DATABASE_URL!, "bxgy-redemption-claims");
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(ENSURE_SERVICE_ROLE);
    await db.query(ORDERS_STUB);
    // The real migration, unmodified — never a copy of it.
    await db.query(readFileSync(MIGRATION, "utf8"));
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  beforeEach(async () => {
    await db.query("truncate public.promotion_redemption_claims");
    await db.query("delete from public.orders");
  });

  /**
   * Fire N claims from N separate connections, released together.
   *
   * Separate clients are the whole point: one client serialises its own
   * statements, so a single connection could never expose the race this
   * function exists to close. The barrier makes them contend for real rather
   * than merely overlap.
   */
  async function claimConcurrently(
    attempts: Array<{ orderId: string; email: string }>,
    limits: { max: number | null; perCustomer: number | null },
    promotionId = "buy-1-get-1-free",
  ): Promise<boolean[]> {
    const clients = attempts.map(() => new Client({ connectionString: url }));
    await Promise.all(clients.map((c) => c.connect()));
    try {
      let release: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const runs = clients.map((client, index) => (async () => {
        await barrier;
        const { rows } = await client.query(
          "select public.bxgy_claim_redemption($1,$2,$3,$4,$5,$6) as claimed",
          [promotionId, attempts[index].orderId, attempts[index].email, limits.max, limits.perCustomer, 900],
        );
        return rows[0].claimed as boolean;
      })());
      release!();
      return await Promise.all(runs);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }

  const granted = (results: boolean[]) => results.filter(Boolean).length;

  it("lets exactly ONE of ten simultaneous claims take the last redemption", async () => {
    const attempts = Array.from({ length: 10 }, (_, i) => ({
      orderId: `order-${i}`,
      email: `shopper-${i}@example.test`,
    }));

    const results = await claimConcurrently(attempts, { max: 1, perCustomer: null });

    expect(granted(results)).toBe(1);
    const { rows } = await db.query("select count(*)::int as n from public.promotion_redemption_claims");
    expect(rows[0].n).toBe(1);
  }, 30_000);

  it("grants exactly the configured number when many race for a few slots", async () => {
    const attempts = Array.from({ length: 20 }, (_, i) => ({
      orderId: `order-${i}`,
      email: `shopper-${i}@example.test`,
    }));

    const results = await claimConcurrently(attempts, { max: 5, perCustomer: null });

    expect(granted(results)).toBe(5);
  }, 30_000);

  it("holds a PER-CUSTOMER limit against one shopper firing eight checkouts at once", async () => {
    // The abuse case: same email, eight parallel submissions, "one per customer".
    const attempts = Array.from({ length: 8 }, (_, i) => ({
      orderId: `order-${i}`,
      email: "repeat@example.test",
    }));

    const results = await claimConcurrently(attempts, { max: null, perCustomer: 1 });

    expect(granted(results)).toBe(1);
  }, 30_000);

  it("applies the per-customer limit per email, not across shoppers", async () => {
    const attempts = [
      { orderId: "a1", email: "one@example.test" },
      { orderId: "a2", email: "one@example.test" },
      { orderId: "b1", email: "two@example.test" },
      { orderId: "b2", email: "two@example.test" },
    ];

    const results = await claimConcurrently(attempts, { max: null, perCustomer: 1 });

    expect(granted(results)).toBe(2); // one each
  }, 30_000);

  it("matches emails case- and whitespace-insensitively under contention", async () => {
    const attempts = [
      { orderId: "a1", email: "Repeat@Example.test" },
      { orderId: "a2", email: "  repeat@example.test " },
    ];

    const results = await claimConcurrently(attempts, { max: null, perCustomer: 1 });

    expect(granted(results)).toBe(1);
  }, 30_000);

  it("never contends across different promotions", async () => {
    const clients = [new Client({ connectionString: url }), new Client({ connectionString: url })];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const [a, b] = await Promise.all([
        clients[0].query("select public.bxgy_claim_redemption('promo-a','o1','x@example.test',1,null,900) as c"),
        clients[1].query("select public.bxgy_claim_redemption('promo-b','o2','x@example.test',1,null,900) as c"),
      ]);
      expect(a.rows[0].c).toBe(true);
      expect(b.rows[0].c).toBe(true);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }, 30_000);
});

describeDb("what a claim counts, and what releases it", () => {
  let url: string;
  let db: Client;

  beforeAll(async () => {
    url = await createSuiteDatabase(DATABASE_URL!, "bxgy-redemption-counting");
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(ENSURE_SERVICE_ROLE);
    await db.query(ORDERS_STUB);
    await db.query(readFileSync(MIGRATION, "utf8"));
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  beforeEach(async () => {
    await db.query("truncate public.promotion_redemption_claims");
    await db.query("delete from public.orders");
  });

  async function claim(orderId: string, email = "s@example.test", holdSeconds = 900): Promise<boolean> {
    const { rows } = await db.query(
      "select public.bxgy_claim_redemption('p1',$1,$2,null,null,$3) as c",
      [orderId, email, holdSeconds],
    );
    return rows[0].c;
  }

  async function count(email: string | null = null, holdSeconds = 900): Promise<number> {
    const { rows } = await db.query(
      "select public.bxgy_count_redemptions('p1',$1,$2) as n", [email, holdSeconds],
    );
    return rows[0].n;
  }

  async function setStatus(orderId: string, status: string) {
    await db.query(
      "insert into public.orders(order_id, payment_status) values($1,$2) on conflict (order_id) do update set payment_status = excluded.payment_status",
      [orderId, status],
    );
  }

  it("counts a fresh hold even before the order row exists", async () => {
    await claim("o1");
    expect(await count()).toBe(1);
  });

  it("counts a paid order forever, past the hold window", async () => {
    await claim("o1");
    await setStatus("o1", "paid");
    expect(await count(null, 0)).toBe(1); // hold expired; the sale still counts
  });

  it("counts a partially refunded order — the sale happened", async () => {
    await claim("o1");
    await setStatus("o1", "partially_refunded");
    expect(await count(null, 0)).toBe(1);
  });

  it("RELEASES on refund, cancellation and payment failure", async () => {
    for (const status of ["refunded", "canceled", "cancelled", "payment_failed"]) {
      await db.query("truncate public.promotion_redemption_claims");
      await db.query("delete from public.orders");
      await claim("o1");
      expect(await count()).toBe(1);
      await setStatus("o1", status);
      expect(await count(), `status ${status} should release the redemption`).toBe(0);
    }
  });

  it("releases an abandoned checkout when the hold expires", async () => {
    await claim("o1");
    await setStatus("o1", "pending_payment");
    expect(await count(null, 900)).toBe(1);
    expect(await count(null, 0)).toBe(0); // hold window elapsed
  });

  it("releases a claim whose order was never written, once the hold expires", async () => {
    await claim("o1");
    expect(await count(null, 0)).toBe(0);
  });

  it("is idempotent for the same order — a retry consumes no second slot", async () => {
    const { rows: first } = await db.query(
      "select public.bxgy_claim_redemption('p1','o1','s@example.test',1,null,900) as c");
    const { rows: second } = await db.query(
      "select public.bxgy_claim_redemption('p1','o1','s@example.test',1,null,900) as c");
    expect(first[0].c).toBe(true);
    expect(second[0].c).toBe(true); // the retry succeeds
    expect(await count()).toBe(1);  // and did not consume another slot
  });

  it("refuses once the limit is reached, and grants again after a release", async () => {
    const one = await db.query("select public.bxgy_claim_redemption('p1','o1','a@example.test',1,null,900) as c");
    expect(one.rows[0].c).toBe(true);
    const two = await db.query("select public.bxgy_claim_redemption('p1','o2','b@example.test',1,null,900) as c");
    expect(two.rows[0].c).toBe(false);

    await setStatus("o1", "refunded");
    const three = await db.query("select public.bxgy_claim_redemption('p1','o3','c@example.test',1,null,900) as c");
    expect(three.rows[0].c).toBe(true);
  });

  it("release returns the slot immediately, but never for a paid order", async () => {
    await claim("o1");
    await setStatus("o1", "paid");
    const { rows } = await db.query("select public.bxgy_release_redemption('o1') as released");
    expect(rows[0].released).toBe(false);
    expect(await count()).toBe(1);

    await claim("o2");
    const { rows: r2 } = await db.query("select public.bxgy_release_redemption('o2') as released");
    expect(r2[0].released).toBe(true);
  });
});
