import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// TWO WAYS THIS SWEEP CAN LOSE A REAL OBLIGATION, AND NEITHER HAD A TEST.
//
// (A) WHICH ROWS IT CAN SEE. `limit` was applied as `.limit(100)` on the
//     candidate SELECT while the "has no accrual" filter ran in JavaScript
//     afterwards. A hundred already-accrued orders at the oldest end of the
//     window therefore filled the page on every tick, forever, and the 101st
//     order — the one with a genuinely missing commission — was never read.
//     Separately, `.gte("paid_at", since)` never matches a NULL `paid_at`, so a
//     paid order without one was invisible at ANY limit, permanently.
//     Both are MISSED COMMISSION: money owed to a real person that is never
//     created. The shipping sweep had the same defect and the same fix.
//
// (B) WHAT IT CALLS SUCCESS. `accrualLandedConcurrently` classified on the
//     error CODE and confirmed with "does a referral_orders row exist?" — which
//     is trivially true when THIS run just inserted it. ensureCommissionRecord
//     writes two non-transactional rows:
//
//         referral_orders  insert   (what the payout reads)
//         commissions      upsert   (what the profit report reads)
//
//     so an insert that succeeds followed by a mirror upsert that raises 23505
//     produced {scanned:1, repaired:0, converged:1, failed:0} and NO alert. The
//     ambassador gets paid, the profit report never sees the expense, and the
//     next sweep is a no-op because it keys on the ledger row's absence.
//     Mutation M10 in the money re-certification found that the "conservative
//     direction" this module documents as its key safety property could be
//     replaced with `return true` and the whole suite stayed green.
//
// The double below models the query surface FAITHFULLY — the or-filter, NULL
// ordering, offset paging, and both tables the confirming read consults — since
// a double that ignores the filters cannot tell any of this apart.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: {
  orders: Row[];
  referral_orders: Row[];
  commissions: Row[];
  alerts: Row[];
} = { orders: [], referral_orders: [], commissions: [], alerts: [] };

const accrue = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-webhook", () => ({ accrueCommissionForPaidOrder: accrue.fn }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: Row) => { db.alerts.push(alert); }),
}));

vi.mock("@/lib/supabase-server", () => {
  /** PostgREST's or() grammar: `col.op.value` terms, and `and(...)` groups. */
  function splitTop(expr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of expr) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    if (current.trim() !== "") parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function evalTerm(row: Row, term: string): boolean {
    if (term.startsWith("and(") && term.endsWith(")")) {
      return splitTop(term.slice(4, -1)).every((sub) => evalTerm(row, sub));
    }
    const first = term.indexOf(".");
    const second = term.indexOf(".", first + 1);
    if (first < 0 || second < 0) throw new Error(`unsupported or() term: ${term}`);
    const column = term.slice(0, first);
    const op = term.slice(first + 1, second);
    const value = term.slice(second + 1);
    if (op === "is") {
      if (value !== "null") throw new Error(`unsupported is.${value}`);
      return (row[column] ?? null) === null;
    }
    if (op === "gte") return row[column] != null && String(row[column]) >= value;
    throw new Error(`unsupported or() operator: ${op}`);
  }

  function builder(table: string) {
    const rows = (db as unknown as Record<string, Row[]>)[table];
    if (!Array.isArray(rows)) throw new Error(`unexpected table in test: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const sortKeys: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let take: number | null = null;
    let skip = 0;

    function settle() {
      let out = rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row }));
      if (sortKeys.length > 0) {
        out.sort((a, b2) => {
          for (const { col, asc, nullsFirst } of sortKeys) {
            const av = a[col] ?? null;
            const bv = b2[col] ?? null;
            if (av === null && bv === null) continue;
            if (av === null) return nullsFirst ? -1 : 1;
            if (bv === null) return nullsFirst ? 1 : -1;
            const cmp = String(av).localeCompare(String(bv));
            if (cmp !== 0) return asc ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (skip > 0) out = out.slice(skip);
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push((row) => String(row[col] ?? "") === String(value)); return b; },
      not(col: string, op: string, value: unknown) {
        if (op !== "is" || value !== null) throw new Error(`unsupported .not(${op})`);
        filters.push((row) => (row[col] ?? null) !== null);
        return b;
      },
      gte(col: string, value: unknown) { filters.push((row) => row[col] != null && String(row[col]) >= String(value)); return b; },
      or(expr: string) {
        const terms = splitTop(expr);
        filters.push((row) => terms.some((term) => evalTerm(row, term)));
        return b;
      },
      in(col: string, values: unknown[]) {
        const set = new Set(values.map(String));
        filters.push((row) => set.has(String(row[col])));
        return b;
      },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        sortKeys.push({ col, asc: opts?.ascending !== false, nullsFirst: opts?.nullsFirst === true });
        return b;
      },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) { skip = from; take = to - from + 1; return b; },
      maybeSingle() {
        const { data } = settle();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }

  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

const { repairMissingCommissionAccruals } = await import("@/lib/commission-accrual-repair");

const AMBASSADOR = "amb-0001";
const NOW = new Date("2026-08-26T12:00:00.000Z");

/** Day D of August 2026. Older = smaller D, so paid_at sorts oldest-first. */
const day = (index: number) => `2026-08-${String(index).padStart(2, "0")}T10:00:00Z`;

function order(id: string, overrides: Row = {}): Row {
  return {
    order_id: id,
    payment_status: "paid",
    ambassador_id: AMBASSADOR,
    referral_code: "AMB15",
    subtotal: 200,
    discount_amount: 20,
    customer_email: "buyer@example.test",
    shipping_address: "1 Test St",
    city: "Testville",
    postal_code: "00000",
    paid_at: day(20),
    created_at: day(20),
    ...overrides,
  };
}

/** An order that already has its accrual — the class that used to fill the page. */
function accruedOrder(id: string, overrides: Row = {}): Row {
  db.referral_orders.push({
    id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 27, payment_status: "pending",
  });
  db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: AMBASSADOR, commission_amount: 27, status: "pending" });
  return order(id, overrides);
}

/** The real accrual, as far as this sweep can tell: both rows, one amount. */
function accrualWritesBothLedgers() {
  accrue.fn.mockImplementation(async (row: Row) => {
    const id = String(row.order_id);
    db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 27, payment_status: "pending" });
    db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: AMBASSADOR, commission_amount: 27, status: "pending" });
  });
}

function unrecoveredAlerts() {
  return db.alerts.filter((a) => a.type === "commission_accrual_unrecovered");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orders = [];
  db.referral_orders = [];
  db.commissions = [];
  db.alerts = [];
  accrualWritesBothLedgers();
});

describe("which rows the sweep can even see", () => {
  it("100 already-accrued orders at the oldest end cannot hide the 101st missing one", async () => {
    // The exact production shape: a run of orders that will match the candidate
    // predicate forever (they are paid, referred, and inside the window) but
    // need no work, sitting in front of one that does.
    db.orders = [
      ...Array.from({ length: 100 }, (_, i) => accruedOrder(`old-${String(i).padStart(3, "0")}`, { paid_at: day(1) })),
      order("STARVED-1", { paid_at: day(9) }),
    ];

    const result = await repairMissingCommissionAccruals({ now: NOW });

    // Before the fix: scanned 100, repaired 0, and STARVED-1 never read at all.
    expect(result.repaired).toBe(1);
    expect(result.failed).toBe(0);
    expect(accrue.fn).toHaveBeenCalledTimes(1);
    expect(db.referral_orders.some((r) => r.order_id === "STARVED-1")).toBe(true);
  });

  it("a paid order with a NULL paid_at is reachable at all", async () => {
    // `.gte("paid_at", since)` never matches NULL, so this order could not be
    // repaired at ANY limit, on any tick, forever.
    db.orders = [order("NO-PAID-AT", { paid_at: null, created_at: day(20) })];

    const result = await repairMissingCommissionAccruals({ now: NOW });

    expect(result.scanned).toBe(1);
    expect(result.repaired).toBe(1);
    expect(db.referral_orders.some((r) => r.order_id === "NO-PAID-AT")).toBe(true);
  });

  it("but the window still bounds it: a NULL paid_at order created long ago stays out", async () => {
    // The window has to stay a window, or the scan grows without end.
    db.orders = [order("ANCIENT", { paid_at: null, created_at: "2025-01-01T00:00:00Z" })];
    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.scanned).toBe(0);
    expect(accrue.fn).not.toHaveBeenCalled();
  });

  it("still reads past one page of candidates", async () => {
    // CANDIDATE_PAGE_SIZE is 200, so a 250-row window proves the paging works
    // rather than the whole window happening to fit in one request.
    db.orders = [
      ...Array.from({ length: 250 }, (_, i) => accruedOrder(`p-${String(i).padStart(3, "0")}`, { paid_at: day(2) })),
      order("BEHIND-A-PAGE", { paid_at: day(9) }),
    ];
    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.scanned).toBe(251);
    expect(result.repaired).toBe(1);
  });

  it("`limit` bounds the accruals attempted, and the rest are reported as deferred", async () => {
    db.orders = Array.from({ length: 5 }, (_, i) => order(`m-${i}`, { paid_at: day(10 + i) }));
    const result = await repairMissingCommissionAccruals({ now: NOW, limit: 2 });

    expect(result.repaired).toBe(2);
    expect(result.deferred).toBe(3);
    // Oldest first, so the ambassador who has been waiting longest is paid first.
    expect(accrue.fn.mock.calls.map((call) => (call[0] as Row).order_id)).toEqual(["m-0", "m-1"]);
  });
});

describe("what the sweep is allowed to call convergence", () => {
  /**
   * The half-written accrual: referral_orders committed, the commissions mirror
   * refused. This is what `ensureCommissionRecord` does when the mirror upsert
   * raises 23505 after the ledger insert has already landed.
   */
  function ledgerLandsMirrorDoesNot() {
    accrue.fn.mockImplementation(async (row: Row) => {
      const id = String(row.order_id);
      db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 27, payment_status: "pending" });
      throw { code: "23505", message: 'duplicate key value violates unique constraint "commissions_order_id_key"' };
    });
  }

  it("a ledger row this run wrote, with NO mirror, is a FAILURE and it alerts", async () => {
    db.orders = [order("HALF-WRITTEN")];
    ledgerLandsMirrorDoesNot();

    const result = await repairMissingCommissionAccruals({ now: NOW });

    // Before the fix this was {converged: 1, failed: 0} with ALERTS: [].
    expect(result.converged).toBe(0);
    expect(result.failed).toBe(1);
    const alert = unrecoveredAlerts()[0];
    expect(alert).toBeDefined();
    const failures = (alert.context as { failures: Array<{ orderId: string; error: string }> }).failures;
    expect(failures[0].orderId).toBe("HALF-WRITTEN");
    // The operator is told WHICH ledger is missing, not just "23505".
    expect(failures[0].error).toContain("mirror is MISSING");
  });

  it("a genuine concurrent accrual — both ledgers, same ambassador, same money — IS convergence", async () => {
    db.orders = [order("RACED")];
    accrue.fn.mockImplementation(async (row: Row) => {
      const id = String(row.order_id);
      // The winner (a live webhook) wrote BOTH rows a moment ago.
      db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 27, payment_status: "pending" });
      db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: AMBASSADOR, commission_amount: 27, status: "pending" });
      throw { code: "23505", message: 'duplicate key value violates unique constraint "referral_orders_order_id_key"' };
    });

    const result = await repairMissingCommissionAccruals({ now: NOW });

    expect(result.converged).toBe(1);
    expect(result.failed).toBe(0);
    // Convergence is a normal outcome and must NOT cry wolf.
    expect(unrecoveredAlerts()).toHaveLength(0);
  });

  it("a commission of $0 with both ledgers agreeing is still convergence", async () => {
    // ensureCommissionRecord legitimately writes 0 with an ineligible_reason
    // (program off, commissions paused, ambassador not active, under the
    // minimum order). Zero is not absence.
    db.orders = [order("INELIGIBLE")];
    accrue.fn.mockImplementation(async (row: Row) => {
      const id = String(row.order_id);
      db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 0, payment_status: "pending" });
      db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: AMBASSADOR, commission_amount: 0, status: "pending" });
      throw { code: "23505", message: "duplicate key" };
    });

    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.converged).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("two ledgers that disagree about the money is NOT convergence", async () => {
    db.orders = [order("DISAGREE")];
    accrue.fn.mockImplementation(async (row: Row) => {
      const id = String(row.order_id);
      db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: AMBASSADOR, commission_amount: 27, payment_status: "pending" });
      db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: AMBASSADOR, commission_amount: 12, status: "pending" });
      throw { code: "23505", message: "duplicate key" };
    });

    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.converged).toBe(0);
    expect(result.failed).toBe(1);
    const failures = (unrecoveredAlerts()[0].context as { failures: Array<{ error: string }> }).failures;
    expect(failures[0].error).toContain("disagree about the money");
  });

  it("a row belonging to a DIFFERENT ambassador is NOT convergence", async () => {
    db.orders = [order("WRONG-OWNER")];
    accrue.fn.mockImplementation(async (row: Row) => {
      const id = String(row.order_id);
      db.referral_orders.push({ id: `ro-${id}`, order_id: id, ambassador_id: "someone-else", commission_amount: 27, payment_status: "pending" });
      db.commissions.push({ id: `c-${id}`, order_id: id, partner_id: "someone-else", commission_amount: 27, status: "pending" });
      throw { code: "23505", message: "duplicate key" };
    });

    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.converged).toBe(0);
    expect(result.failed).toBe(1);
    const failures = (unrecoveredAlerts()[0].context as { failures: Array<{ error: string }> }).failures;
    expect(failures[0].error).toContain("was not the one that landed");
  });

  it("any error that is NOT a unique violation is still a plain failure, with its diagnosis", async () => {
    db.orders = [order("CHECK-VIOLATION")];
    accrue.fn.mockImplementation(async () => {
      throw {
        code: "23514",
        message: 'violates check constraint "referral_orders_payment_status_check"',
        details: "Failing row contains (pending).",
      };
    });

    const result = await repairMissingCommissionAccruals({ now: NOW });
    expect(result.failed).toBe(1);
    expect(result.converged).toBe(0);
    const failures = (unrecoveredAlerts()[0].context as { failures: Array<{ error: string }> }).failures;
    expect(failures[0].error).toContain("23514");
    expect(failures[0].error).not.toContain("[object Object]");
  });
});
