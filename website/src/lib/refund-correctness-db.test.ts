import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// PHASE 3 REFUND CORRECTNESS, RUN AS THE SHIPPED SQL, AGAINST A REAL POSTGRES.
//
// Both migrations execute here verbatim — not a restatement of them — because
// the failures they fix were failures of the DATABASE refusing what the code
// wrote, and an in-memory fake cannot refuse anything:
//
//   referral-orders-manual-review-status.sql  VL-7  — 'manual_review' is a
//     status the refund path writes and the CHECK rejected with 23514.
//   refund-exactly-once-indexes.sql          REF-03 — the three refund effects
//     that hand money back were exactly-once only by read-then-insert, which
//     the webhook and the repair sweep can both pass.
//
// The narrow constraint is recreated here under the OTHER name the harness uses
// (`pc_ro_ps`), so "drops by rule, not by name" is proved rather than asserted.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[refund-correctness] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const SQL_DIR = path.resolve(__dirname, "sql");
const CONSTRAINT_MIGRATION = readFileSync(path.join(SQL_DIR, "referral-orders-manual-review-status.sql"), "utf8");
const INDEX_MIGRATION = readFileSync(path.join(SQL_DIR, "refund-exactly-once-indexes.sql"), "utf8");

/** Just enough of production's shape for the migrations to act on. */
const SCHEMA = `
create table referral_orders (
  id bigserial primary key,
  order_id text not null unique,
  payment_status text not null default 'paid',
  commission_amount numeric not null default 0
);
-- The ORIGINAL narrow rule, under the name the browser harness uses. A
-- migration that drops only 'referral_orders_payment_status_check' leaves this
-- one enforcing the old list and reports success.
alter table referral_orders add constraint pc_ro_ps
  check (payment_status = any (array['paid','refunded','partially_refunded']));

create table points_ledger (
  id bigserial primary key,
  user_id uuid not null,
  amount integer not null,
  reason text not null,
  order_id text,
  created_at timestamptz not null default now()
);
create table store_credit_ledger (
  id bigserial primary key,
  user_id uuid not null,
  amount_cents integer not null,
  reason text not null,
  order_id text,
  created_at timestamptz not null default now()
);
`;

const USER = "11111111-1111-1111-1111-111111111111";

describeDb("the Phase 3 refund migrations, as they will actually ship", () => {
  let db: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "refund-correctness");
    db = new Client({ connectionString: suiteUrl });
    await db.connect();
    await db.query(SCHEMA);
    await db.query(CONSTRAINT_MIGRATION);
    await db.query(INDEX_MIGRATION);
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  async function refused(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await db.query(sql, params);
      return "";
    } catch (error) {
      return String((error as { code?: string }).code ?? "");
    }
  }

  describe("VL-7 — the commission lifecycle the refund path writes", () => {
    it("accepts 'manual_review', the value that raised 23514", async () => {
      await db.query(
        "insert into referral_orders (order_id, payment_status) values ('o-mr', 'manual_review')",
      );
      const { rows } = await db.query("select payment_status from referral_orders where order_id='o-mr'");
      expect(rows[0].payment_status).toBe("manual_review");
    });

    it("dropped the narrow duplicate that was hiding under another name", async () => {
      const { rows } = await db.query(
        `select conname from pg_constraint where conrelid='referral_orders'::regclass and contype='c'
           and pg_get_constraintdef(oid) like '%payment_status%'`,
      );
      expect(rows.map((row) => row.conname)).toEqual(["referral_orders_payment_status_check"]);
    });

    it("still refuses a status that is not part of the lifecycle at all", async () => {
      // Widened, not removed: a typo'd status is still a write that fails loudly.
      expect(await refused("insert into referral_orders (order_id, payment_status) values ('o-x', 'whatever')"))
        .toBe("23514");
    });

    it("still accepts the accrual and payout statuses", async () => {
      for (const status of ["pending", "approved_for_payout", "paid", "reversed", "voided", "refunded", "partially_refunded"]) {
        await db.query("insert into referral_orders (order_id, payment_status) values ($1, $2)", [`o-${status}`, status]);
      }
      const { rows } = await db.query("select count(*)::int as n from referral_orders");
      expect(rows[0].n).toBeGreaterThanOrEqual(7);
    });
  });

  describe("REF-03 — one refund, one credit, whoever gets there second", () => {
    const insertPoints = "insert into points_ledger (user_id, amount, reason, order_id) values ($1,$2,$3,$4)";

    it("refuses a second points reversal for the same order", async () => {
      await db.query(insertPoints, [USER, -300, "order_refund_reversal", "o-1"]);
      expect(await refused(insertPoints, [USER, -300, "order_refund_reversal", "o-1"])).toBe("23505");
    });

    it("refuses a second points restore for the same order", async () => {
      await db.query(insertPoints, [USER, 400, "order_refund_points_restore", "o-1"]);
      expect(await refused(insertPoints, [USER, 400, "order_refund_points_restore", "o-1"])).toBe("23505");
    });

    it("leaves the two refund reasons independent of each other", async () => {
      // Both landed above for the same order: one reversal AND one restore.
      const { rows } = await db.query(
        `select count(*)::int as n from points_ledger where order_id='o-1'
           and reason in ('order_refund_reversal','order_refund_points_restore')`,
      );
      expect(rows[0].n).toBe(2);
    });

    it("leaves ORDINARY ledger rows free to repeat", async () => {
      // Earns, redemptions and adjustments are not constrained — only refunds.
      await db.query(insertPoints, [USER, 10, "order_earn", "o-1"]);
      await db.query(insertPoints, [USER, 10, "order_earn", "o-1"]);
      const { rows } = await db.query("select count(*)::int as n from points_ledger where reason='order_earn'");
      expect(rows[0].n).toBe(2);
    });

    it("refuses a second store-credit return for the same order and account", async () => {
      const insertCredit = "insert into store_credit_ledger (user_id, amount_cents, reason, order_id) values ($1,$2,$3,$4)";
      await db.query(insertCredit, [USER, 2500, "membership_redemption_refund", "o-1"]);
      expect(await refused(insertCredit, [USER, 2500, "membership_redemption_refund", "o-1"])).toBe("23505");
      // The redemption it reverses is untouched, and repeats freely.
      await db.query(insertCredit, [USER, -2500, "membership_redemption", "o-1"]);
      await db.query(insertCredit, [USER, -2500, "membership_redemption", "o-1"]);
      const { rows } = await db.query(
        "select count(*)::int as n from store_credit_ledger where reason='membership_redemption'",
      );
      expect(rows[0].n).toBe(2);
    });

    it("REFUSES to run over existing duplicates rather than picking one to delete", async () => {
      // Duplicates here are money already handed out twice. The migration stops
      // and names the reconciliation instead of resolving it silently.
      await db.query("drop index idx_points_ledger_order_refund_once");
      await db.query(insertPoints, [USER, -300, "order_refund_reversal", "o-dupe"]);
      await db.query(insertPoints, [USER, -300, "order_refund_reversal", "o-dupe"]);

      await expect(db.query(INDEX_MIGRATION)).rejects.toThrow(/duplicate refund rows/i);
      const { rows } = await db.query("select count(*)::int as n from points_ledger where order_id='o-dupe'");
      expect(rows[0].n).toBe(2); // untouched — an operator decides, not a migration

      // Reconciled by hand, the migration then applies.
      await db.query("delete from points_ledger where order_id='o-dupe' and id = (select max(id) from points_ledger where order_id='o-dupe')");
      await db.query(INDEX_MIGRATION);
    });

    it("is re-runnable: applying both migrations twice changes nothing", async () => {
      await db.query(CONSTRAINT_MIGRATION);
      await db.query(INDEX_MIGRATION);
      const { rows } = await db.query(
        `select count(*)::int as n from pg_indexes where indexname in
           ('idx_points_ledger_order_refund_once','idx_store_credit_ledger_order_refund_once')`,
      );
      expect(rows[0].n).toBe(2);
    });
  });
});
