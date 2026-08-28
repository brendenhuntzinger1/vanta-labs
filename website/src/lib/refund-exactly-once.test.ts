import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EXACTLY-ONCE FOR THE THREE REFUND EFFECTS THAT HAND MONEY BACK. (REF-03 / F3)
//
// points_ledger       'order_refund_reversal'        claw back earned points
// points_ledger       'order_refund_points_restore'  return redeemed points
// store_credit_ledger 'membership_redemption_refund' return store credit
//
// Each was guarded by a SELECT immediately before its INSERT. That is not
// exactly-once, and this codebase runs TWO writers against it deliberately:
// processPaymentWebhook's refund branch, and refund-effect-repair.ts (the
// half-hourly sweep), which selects on exactly the ABSENCE those guards read.
// Both can read "no row yet" and both insert. The customer is credited twice
// and neither caller notices — both report success.
//
// The fix is a partial unique index per effect
// (sql/refund-exactly-once-indexes.sql), so the loser of the race is refused by
// Postgres. This file holds the two halves of that:
//
//   1. the SQL declares the indexes, and the harness applies them;
//   2. the application treats the resulting 23505 as "already applied" — a
//      no-op, NOT a failure. A failure here would have the sweep alerting on
//      refunds that are correctly applied, and (worse) retrying them forever.
//
// The indexes themselves are verified against a real Postgres carrying the
// production-parity schema by the harness setup, not mocked here.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db = {
  pointsLedger: [] as Row[],
  storeCreditLedger: [] as Row[],
  order: {
    customer_user_id: "user-1" as string | null,
    points_earned: 300,
    points_redeemed: 400,
  },
  /**
   * Rows another writer inserts between the guard's read and our insert.
   * `raceAfterReads` says WHICH read it lands after, because that is the whole
   * question: land it before the guard reads and the guard catches it (the case
   * that always worked); land it after the LAST read and only the database can.
   */
  raceInsert: null as (() => void) | null,
  raceAfterReads: 1,
  reads: 0,
};

/**
 * One read of the fake. Fires the racing writer when it is due.
 *
 * Only the LIST reads are counted (`.limit()` and awaiting the builder) —
 * `.maybeSingle()` is the order lookup, which happens before any guard.
 */
function countRead() {
  db.reads += 1;
  if (db.raceInsert && db.reads >= db.raceAfterReads) {
    db.raceInsert();
    db.raceInsert = null;
  }
}

/** The partial unique indexes, enforced by the fake exactly as Postgres does. */
function pointsUniqueViolation(row: Row): boolean {
  const reason = String(row.reason ?? "");
  if (!["order_refund_reversal", "order_refund_points_restore"].includes(reason)) return false;
  return db.pointsLedger.some((r) => r.order_id === row.order_id && r.reason === reason);
}

function creditUniqueViolation(row: Row): boolean {
  if (String(row.reason ?? "") !== "membership_redemption_refund") return false;
  return db.storeCreditLedger.some(
    (r) => r.order_id === row.order_id && r.reason === row.reason && r.user_id === row.user_id,
  );
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  function selectBuilder(rows: () => Row[]) {
    const filters: Array<[string, unknown]> = [];
    const apply = () => rows().filter((row) => filters.every(([col, value]) => row[col] === value));
    const b: Record<string, unknown> = {
      eq(col: string, value: unknown) { filters.push([col, value]); return b; },
      gte() { return b; },
      async limit() {
        const found = apply();
        countRead();
        return { data: found.slice(0, 1), error: null };
      },
      async maybeSingle() { return { data: apply()[0] ?? null, error: null }; },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const found = apply();
        countRead();
        return Promise.resolve({ data: found, error: null }).then(resolve);
      },
    };
    return b;
  }

  const from = (table: string) => {
    if (table === "orders") {
      return { select: () => selectBuilder(() => [{ ...db.order, order_id: "order-1" }]) };
    }
    if (table === "points_ledger") {
      return {
        select: () => selectBuilder(() => db.pointsLedger),
        async insert(row: Row) {
          if (pointsUniqueViolation(row)) {
            return { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_points_ledger_order_refund_once"' } };
          }
          db.pointsLedger.push(row);
          return { error: null };
        },
      };
    }
    if (table === "store_credit_ledger") {
      return {
        select: () => selectBuilder(() => db.storeCreditLedger),
        async insert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          // One statement: if any row violates, NOTHING is written.
          if (list.some((row) => creditUniqueViolation(row))) {
            return { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_store_credit_ledger_order_refund_once"' } };
          }
          db.storeCreditLedger.push(...list);
          return { error: null };
        },
      };
    }
    return { select: () => selectBuilder(() => []), insert: async () => ({ error: null }) };
  };
  return { supabaseAdmin: { from } };
});

const ORDER = "order-1";

/** A redemption row for this order, spent this month so it is refundable. */
function redemption(amountCents: number, userId = "user-1") {
  return {
    user_id: userId,
    amount_cents: -amountCents,
    reason: "membership_redemption",
    order_id: ORDER,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  db.pointsLedger = [];
  db.storeCreditLedger = [];
  db.order = { customer_user_id: "user-1", points_earned: 300, points_redeemed: 400 };
  db.raceInsert = null;
  db.raceAfterReads = 1;
  db.reads = 0;
});

describe("the points reversal", () => {
  it("writes one reversal and reports it", async () => {
    const { reverseOrderPoints } = await import("@/lib/membership");
    expect(await reverseOrderPoints(ORDER)).toBe(true);
    expect(db.pointsLedger.filter((r) => r.reason === "order_refund_reversal")).toHaveLength(1);
  });

  it("LOSES THE RACE WITHOUT DOUBLE-DEBITING the customer", async () => {
    const { reverseOrderPoints } = await import("@/lib/membership");
    // The sweep inserts its reversal after our guard read and before our insert.
    db.raceAfterReads = 1; // after the existing-row guard, the last read before the insert
    db.raceInsert = () => db.pointsLedger.push({
      user_id: "user-1", amount: -300, reason: "order_refund_reversal", order_id: ORDER,
    });

    // No throw, and no second row: "somebody else already did it" is a no-op.
    await expect(reverseOrderPoints(ORDER)).resolves.toBe(false);
    expect(db.pointsLedger.filter((r) => r.reason === "order_refund_reversal")).toHaveLength(1);
  });

  it("still surfaces a REAL write failure", async () => {
    // 23505 is the only code that means "already applied". Everything else is a
    // failure the sweep must count and alert on.
    const { reverseOrderPoints, isDuplicateLedgerRow } = await import("@/lib/membership");
    expect(isDuplicateLedgerRow({ code: "23505" })).toBe(true);
    expect(isDuplicateLedgerRow({ code: "42501" })).toBe(false);
    expect(isDuplicateLedgerRow(new Error("timeout"))).toBe(false);
    expect(await reverseOrderPoints(ORDER)).toBe(true);
  });
});

describe("the redeemed-points restore", () => {
  beforeEach(() => {
    // The debit the restore reads back: what was actually taken.
    db.pointsLedger.push({ user_id: "user-1", amount: -400, reason: "redeem", order_id: ORDER });
  });

  it("restores exactly what the ledger says was debited", async () => {
    const { restoreRedeemedPoints } = await import("@/lib/membership");
    expect(await restoreRedeemedPoints(ORDER)).toBe(true);
    const restored = db.pointsLedger.filter((r) => r.reason === "order_refund_points_restore");
    expect(restored).toHaveLength(1);
    expect(restored[0].amount).toBe(400);
  });

  it("LOSES THE RACE WITHOUT DOUBLE-CREDITING the customer", async () => {
    const { restoreRedeemedPoints } = await import("@/lib/membership");
    db.raceAfterReads = 2; // existing-row guard, then the debit sum
    db.raceInsert = () => db.pointsLedger.push({
      user_id: "user-1", amount: 400, reason: "order_refund_points_restore", order_id: ORDER,
    });

    await expect(restoreRedeemedPoints(ORDER)).resolves.toBe(false);
    expect(db.pointsLedger.filter((r) => r.reason === "order_refund_points_restore")).toHaveLength(1);
  });
});

describe("the store-credit return", () => {
  it("returns the credit once", async () => {
    db.storeCreditLedger.push(redemption(2500));
    const { refundStoreCreditForOrder } = await import("@/lib/store-credit");
    expect(await refundStoreCreditForOrder(ORDER)).toBe(true);
    const refunds = db.storeCreditLedger.filter((r) => r.reason === "membership_redemption_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount_cents).toBe(2500);
  });

  it("writes ONE row per account even when the order has several redemptions", async () => {
    // The shape the unique index requires. The AMOUNT is unchanged — it is the
    // sum — but "one refund row per order" is now something the database can
    // hold, which it could not when this wrote one row per redemption.
    db.storeCreditLedger.push(redemption(1500), redemption(1000));
    const { refundStoreCreditForOrder } = await import("@/lib/store-credit");
    expect(await refundStoreCreditForOrder(ORDER)).toBe(true);
    const refunds = db.storeCreditLedger.filter((r) => r.reason === "membership_redemption_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount_cents).toBe(2500);
  });

  it("LOSES THE RACE WITHOUT RETURNING THE CREDIT TWICE", async () => {
    db.storeCreditLedger.push(redemption(2500));
    const { refundStoreCreditForOrder } = await import("@/lib/store-credit");
    // AFTER the already-refunded guard has read (redemptions, then the guard),
    // so the guard cannot catch it and the index has to.
    db.raceAfterReads = 2;
    db.raceInsert = () => db.storeCreditLedger.push({
      user_id: "user-1", amount_cents: 2500, reason: "membership_redemption_refund", order_id: ORDER,
    });

    await expect(refundStoreCreditForOrder(ORDER)).resolves.toBe(false);
    expect(db.storeCreditLedger.filter((r) => r.reason === "membership_redemption_refund")).toHaveLength(1);
  });

  it("still reports credit that expired as not returned, without inventing a row", async () => {
    // Prior-month credit is use-it-or-lose-it; the refundable filter still runs.
    db.storeCreditLedger.push({ ...redemption(2500), created_at: "2020-01-05T00:00:00.000Z" });
    const { refundStoreCreditForOrder } = await import("@/lib/store-credit");
    expect(await refundStoreCreditForOrder(ORDER)).toBe(false);
    expect(db.storeCreditLedger.filter((r) => r.reason === "membership_redemption_refund")).toHaveLength(0);
  });
});

describe("the migration that makes the race impossible", () => {
  const SQL_DIR = join(process.cwd(), "src/lib/sql");
  const migration = readFileSync(join(SQL_DIR, "refund-exactly-once-indexes.sql"), "utf8");

  it("declares a unique index over both points refund reasons", () => {
    expect(migration).toMatch(/create unique index if not exists idx_points_ledger_order_refund_once/);
    expect(migration).toMatch(/order_refund_reversal/);
    expect(migration).toMatch(/order_refund_points_restore/);
  });

  it("declares a unique index over the store-credit return", () => {
    expect(migration).toMatch(/create unique index if not exists idx_store_credit_ledger_order_refund_once/);
    expect(migration).toMatch(/membership_redemption_refund/);
  });

  it("refuses to run over existing duplicates instead of choosing one to delete", () => {
    // Those duplicates are money already handed out. A migration must not pick.
    expect(migration).toMatch(/raise exception/);
    expect(migration).not.toMatch(/delete from public\.(points|store_credit)_ledger/);
  });

  it("is applied by the local harness, so browser testing sees the same rules", () => {
    const setup = readFileSync(join(process.cwd(), "scripts/setup-local-harness.sh"), "utf8");
    expect(setup).toContain("refund-exactly-once-indexes");
  });
});
