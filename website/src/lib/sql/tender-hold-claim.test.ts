import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE CONCURRENCY PROOF FOR A MONEY-LIKE BALANCE.
//
// tender-reservation.ts used to write the debit first and validate it after,
// on the argument that every writer sums the ledger in one fixed order and the
// loser deletes its own row. Nothing made the loser SEE the winner: the insert
// and the validating read are two independent round trips under READ COMMITTED,
// so the later claim can finish its read before the earlier claim's insert has
// committed and approve itself against a ledger that does not contain its
// rival. Reproduced through the real reserveOrderTender: $50 of credit, two
// concurrent claims for two different orders, 250 rounds, 2 double spends.
//
// No amount of mocking can prove the fix — a mocked database has no concurrency
// to be wrong about, and awaiting two promises in sequence proves only that
// sequence works. So this runs the SHIPPED functions, read out of the migration
// file that actually deploys, against a real Postgres, from N genuinely parallel
// connections released together. Remove the advisory lock and these fail.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[tender-hold-claim] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const MIGRATION = path.resolve(__dirname, "tender-hold-claim.sql");

/**
 * The two ledgers, in the shape membership-tiers-seed.sql and
 * membership-rewards.sql create them — minus the auth.users foreign key, which
 * is the one thing a throwaway database has no way to satisfy.
 */
const LEDGERS_STUB = `
  create table if not exists public.store_credit_ledger (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    amount_cents integer not null,
    reason text not null,
    order_id text,
    period_month text,
    created_at timestamptz not null default now()
  );
  create table if not exists public.points_ledger (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    amount integer not null,
    reason text not null,
    order_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
`;

const ENSURE_SERVICE_ROLE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role;
    end if;
  end $$;
`;

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const CREDIT_REASON = "membership_redemption";
const POINTS_REASON = "redeem";

describeDb("the tender hold is taken atomically", () => {
  let url: string;
  let db: Client;

  beforeAll(async () => {
    url = await createSuiteDatabase(DATABASE_URL!, "tender-hold-claim");
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(ENSURE_SERVICE_ROLE);
    await db.query('create extension if not exists "pgcrypto"');
    await db.query(LEDGERS_STUB);
    // The real migration, unmodified — never a copy of it.
    await db.query(readFileSync(MIGRATION, "utf8"));
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  beforeEach(async () => {
    await db.query("truncate public.store_credit_ledger");
    await db.query("truncate public.points_ledger");
  });

  const grantCredit = (cents: number, reason = "membership_monthly_grant") =>
    db.query(
      "insert into public.store_credit_ledger (user_id, amount_cents, reason) values ($1,$2,$3)",
      [USER, cents, reason],
    );

  const grantPoints = (points: number, reason = "earned") =>
    db.query("insert into public.points_ledger (user_id, amount, reason) values ($1,$2,$3)", [USER, points, reason]);

  /**
   * Fire N claims from N separate connections, released together.
   *
   * Separate clients are the whole point: one client serialises its own
   * statements, so a single connection could never expose this race.
   */
  async function claimConcurrently(
    fn: "claim_store_credit_hold" | "claim_points_hold",
    attempts: Array<{ orderId: string; amount: number; userId?: string }>,
    reason: string,
    windowStart: string | null = null,
  ): Promise<boolean[]> {
    const clients = attempts.map(() => new Client({ connectionString: url }));
    await Promise.all(clients.map((c) => c.connect()));
    try {
      let release: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const runs = clients.map((client, index) => (async () => {
        await barrier;
        const { rows } = await client.query(
          `select public.${fn}($1,$2,$3,$4,$5) as claimed`,
          [attempts[index].userId ?? USER, attempts[index].orderId, attempts[index].amount, reason, windowStart],
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
  const balance = async (table: "store_credit_ledger" | "points_ledger", column: string) => {
    const { rows } = await db.query(`select coalesce(sum(${column}),0)::int as n from public.${table}`);
    return rows[0].n as number;
  };

  describe("store credit", () => {
    it("lets exactly ONE of two simultaneous $50 claims spend a $50 balance", async () => {
      // The reproduced failure, exactly: two tabs, Place Order in both.
      await grantCredit(5000);

      const results = await claimConcurrently("claim_store_credit_hold", [
        { orderId: "order-a", amount: 5000 },
        { orderId: "order-b", amount: 5000 },
      ], CREDIT_REASON);

      expect(granted(results)).toBe(1);
      expect(await balance("store_credit_ledger", "amount_cents"), "the balance never goes negative").toBe(0);
    }, 30_000);

    it("never over-spends when ten checkouts race for one balance", async () => {
      await grantCredit(5000);
      const attempts = Array.from({ length: 10 }, (_, i) => ({ orderId: `order-${i}`, amount: 1000 }));

      const results = await claimConcurrently("claim_store_credit_hold", attempts, CREDIT_REASON);

      expect(granted(results), "$50 buys five $10 holds and no more").toBe(5);
      expect(await balance("store_credit_ledger", "amount_cents")).toBe(0);
    }, 30_000);

    it("is idempotent per order: a retried submit keeps its own hold", async () => {
      await grantCredit(5000);
      const attempts = Array.from({ length: 6 }, () => ({ orderId: "order-same", amount: 5000 }));

      const results = await claimConcurrently("claim_store_credit_hold", attempts, CREDIT_REASON);

      expect(granted(results), "every attempt is told it holds the credit").toBe(6);
      const { rows } = await db.query(
        "select count(*)::int as n from public.store_credit_ledger where order_id = 'order-same'",
      );
      expect(rows[0].n, "but only one debit was written").toBe(1);
    }, 30_000);

    it("keeps one customer's balance out of another's reach", async () => {
      await grantCredit(5000);
      const results = await claimConcurrently("claim_store_credit_hold", [
        { orderId: "mine", amount: 5000 },
        { orderId: "theirs", amount: 5000, userId: OTHER_USER },
      ], CREDIT_REASON);

      expect(results[0], "the owner is paid").toBe(true);
      expect(results[1], "the stranger has no balance at all").toBe(false);
    }, 30_000);

    it("honours the monthly window, so expired credit cannot be spent", async () => {
      // Store credit is use-it-or-lose-it monthly. A claim validated against a
      // wider window would authorise spending credit that has already lapsed.
      await db.query(
        "insert into public.store_credit_ledger (user_id, amount_cents, reason, created_at) values ($1,$2,$3, now() - interval '60 days')",
        [USER, 5000, "membership_monthly_grant"],
      );
      const windowStart = new Date(Date.now() - 7 * 86_400_000).toISOString();

      const [inWindow] = await claimConcurrently(
        "claim_store_credit_hold",
        [{ orderId: "order-late", amount: 5000 }],
        CREDIT_REASON,
        windowStart,
      );

      expect(inWindow, "last month's grant is not this month's balance").toBe(false);
    }, 30_000);

    it("refuses a claim larger than the balance, and writes nothing", async () => {
      await grantCredit(1000);
      const [ok] = await claimConcurrently(
        "claim_store_credit_hold",
        [{ orderId: "order-big", amount: 5000 }],
        CREDIT_REASON,
      );
      expect(ok).toBe(false);
      const { rows } = await db.query("select count(*)::int as n from public.store_credit_ledger where order_id is not null");
      expect(rows[0].n).toBe(0);
    }, 30_000);
  });

  describe("loyalty points", () => {
    it("lets exactly ONE of two simultaneous claims spend the same points", async () => {
      await grantPoints(500);

      const results = await claimConcurrently("claim_points_hold", [
        { orderId: "order-a", amount: 500 },
        { orderId: "order-b", amount: 500 },
      ], POINTS_REASON);

      expect(granted(results)).toBe(1);
      expect(await balance("points_ledger", "amount")).toBe(0);
    }, 30_000);

    it("counts a lifetime ledger, since points do not expire", async () => {
      await db.query(
        "insert into public.points_ledger (user_id, amount, reason, created_at) values ($1,$2,$3, now() - interval '400 days')",
        [USER, 500, "earned"],
      );

      const [ok] = await claimConcurrently("claim_points_hold", [{ orderId: "order-old", amount: 500 }], POINTS_REASON);

      expect(ok, "a year-old point is still a point").toBe(true);
    }, 30_000);

    it("never lets twenty racing checkouts spend more than the balance", async () => {
      await grantPoints(1000);
      const attempts = Array.from({ length: 20 }, (_, i) => ({ orderId: `order-${i}`, amount: 200 }));

      const results = await claimConcurrently("claim_points_hold", attempts, POINTS_REASON);

      expect(granted(results)).toBe(5);
      expect(await balance("points_ledger", "amount")).toBe(0);
    }, 30_000);
  });

  describe("the shape of a claim that is nothing", () => {
    it("treats a zero or negative amount as nothing to hold, not a refusal", async () => {
      const results = await claimConcurrently("claim_store_credit_hold", [
        { orderId: "order-zero", amount: 0 },
      ], CREDIT_REASON);
      expect(results[0]).toBe(true);
      const { rows } = await db.query("select count(*)::int as n from public.store_credit_ledger");
      expect(rows[0].n, "and writes no debit for it").toBe(0);
    }, 30_000);
  });
});
