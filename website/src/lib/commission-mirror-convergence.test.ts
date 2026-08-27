import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A HALF-WRITTEN ACCRUAL MUST CONVERGE, NOT JUST ALERT.
//
// `ensureCommissionRecord` performs TWO non-transactional writes:
//
//     referral_orders  insert   (the ledger the payout reads)
//     commissions      upsert   (the mirror the profit report reads)
//
// When the first commits and the second does not, the obligation is real and
// HALF RECORDED: the ambassador is owed, `updateCommissionOnRefund` updates
// zero mirror rows, and the profit report never sees the expense.
//
// The sweep alerted about that state exactly ONCE — on the tick that produced
// it — and then the order left the candidate set forever, because the candidate
// set keyed on the LEDGER ROW'S ABSENCE and the ledger row is precisely what
// exists. Nothing repaired it, on any later tick, at any limit.
//
// These tests are deliberately NOT static fixtures. A selection fix that is
// correct on one frozen table and wrong under a stream of arrivals is the exact
// regression this project has already shipped once, so the convergence proof
// below runs MANY TICKS while new paid orders keep arriving, and asserts on the
// end state of the whole database rather than on one run's counters.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: {
  orders: Row[];
  referral_orders: Row[];
  commissions: Row[];
  partners: Row[];
  alerts: Row[];
  /** When true the mirror upsert reports success and writes NOTHING. */
  mirrorWriteVanishes: boolean;
} = { orders: [], referral_orders: [], commissions: [], partners: [], alerts: [], mirrorWriteVanishes: false };

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
      // The mirror write. `commissions.order_id` is UNIQUE in production, so an
      // upsert on that conflict target REPLACES rather than duplicating — a
      // double is modelled as impossible here for the same reason it is in the
      // database, and the test asserts the row count to prove it.
      upsert(payload: Row, options?: { onConflict?: string }) {
        // A WRITE WHOSE FAILURE LOOKS LIKE SUCCESS. PostgREST answers `{ error:
        // null }` for a statement that matched and changed nothing — an RLS
        // policy that filters the row away, a conflict target resolving
        // elsewhere. The repair must not report a mirror it cannot then read.
        if (table === "commissions" && db.mirrorWriteVanishes) {
          return Promise.resolve({ data: null, error: null });
        }
        const key = options?.onConflict ?? "id";
        const existing = rows.find((row) => String(row[key]) === String(payload[key]));
        if (existing) Object.assign(existing, payload);
        else rows.push({ id: `gen-${rows.length}`, ...payload });
        return Promise.resolve({ data: null, error: null });
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
const COMMISSION = 27;

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

function ledgerRow(id: string, overrides: Row = {}): Row {
  return {
    id: `ro-${id}`,
    order_id: id,
    ambassador_id: AMBASSADOR,
    referral_code: "AMB15",
    commission_percent: 15,
    customer_discount_percent: 10,
    commission_amount: COMMISSION,
    payment_status: "pending",
    tier_name: "base",
    ineligible_reason: null,
    fraud_flag: false,
    fraud_reason: null,
    created_at: day(20),
    ...overrides,
  };
}

function mirrorRow(id: string, overrides: Row = {}): Row {
  return {
    id: `c-${id}`,
    order_id: id,
    partner_id: AMBASSADOR,
    commission_amount: COMMISSION,
    status: "pending",
    ...overrides,
  };
}

/** A paid, referred order whose accrual landed on BOTH ledgers. Needs no work. */
function healthy(id: string, overrides: Row = {}): Row {
  db.referral_orders.push(ledgerRow(id, { created_at: String(overrides.paid_at ?? day(20)) }));
  db.commissions.push(mirrorRow(id));
  return order(id, overrides);
}

/**
 * THE DEFECT'S SHAPE. The ledger row committed; the mirror upsert did not. The
 * ambassador is owed `COMMISSION` and the profit report cannot see it.
 */
function halfWritten(id: string, overrides: Row = {}): Row {
  db.referral_orders.push(ledgerRow(id, { created_at: String(overrides.paid_at ?? day(20)) }));
  return order(id, overrides);
}

/** The healthy accrual, as far as this sweep can tell: both rows, one amount. */
function accrualWritesBothLedgers() {
  accrue.fn.mockImplementation(async (row: Row) => {
    const id = String(row.order_id);
    db.referral_orders.push(ledgerRow(id));
    db.commissions.push(mirrorRow(id));
  });
}

/** Every order that is missing either side of its obligation. */
function stillBroken(): string[] {
  const ledger = new Set(db.referral_orders.map((r) => String(r.order_id)));
  const mirror = new Set(db.commissions.map((r) => String(r.order_id)));
  return db.orders
    .map((o) => String(o.order_id))
    .filter((id) => !ledger.has(id) || !mirror.has(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orders = [];
  db.referral_orders = [];
  db.commissions = [];
  db.partners = [{ id: AMBASSADOR }];
  db.alerts = [];
  db.mirrorWriteVanishes = false;
  accrualWritesBothLedgers();
});

describe("a ledger row with no mirror is repairable at all", () => {
  it("repairs the mirror the sweep's own alert has been describing", async () => {
    db.orders = [halfWritten("HALF-WRITTEN")];

    const result = await repairMissingCommissionAccruals({ now: NOW });

    // Before the fix: {scanned:1, repaired:0, ...} and the order stayed broken
    // on every subsequent tick, forever, because the candidate set keyed on the
    // ledger row's ABSENCE.
    expect(db.commissions.map((r) => r.order_id)).toContain("HALF-WRITTEN");
    expect(result.mirrorRepaired).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("the repaired mirror carries the ledger's money, ambassador and status", async () => {
    // The mirror is not merely PRESENT: the payout ledger and the profit report
    // have to agree about who is owed and how much, or the repair has only
    // moved the disagreement.
    db.orders = [halfWritten("AGREE", { paid_at: day(11) })];
    db.referral_orders[0].commission_amount = 41.5;
    db.referral_orders[0].payment_status = "approved_for_payout";

    await repairMissingCommissionAccruals({ now: NOW });

    const mirror = db.commissions.find((r) => r.order_id === "AGREE");
    expect(mirror).toBeDefined();
    expect(Number(mirror!.commission_amount)).toBe(41.5);
    expect(String(mirror!.partner_id)).toBe(AMBASSADOR);
    // A commission already approved for payout must NOT be mirrored as
    // "pending": the two ledgers would then disagree about where in the payout
    // lifecycle this obligation is.
    expect(String(mirror!.status)).toBe("approved_for_payout");
  });

  it("does not re-accrue: the payout ledger is left exactly as it was", async () => {
    // Re-running the ACCRUAL for an order that already has a ledger row is how
    // an obligation gets restated (or, on a row past `pending`, silently not
    // written at all). The mirror is the only thing missing, so the mirror is
    // the only thing written.
    db.orders = [halfWritten("NO-REACCRUAL")];

    await repairMissingCommissionAccruals({ now: NOW });

    // Asserted FIRST so this cannot pass by the order never being looked at.
    expect(db.commissions.map((r) => r.order_id)).toContain("NO-REACCRUAL");
    expect(accrue.fn).not.toHaveBeenCalled();
    expect(db.referral_orders).toHaveLength(1);
    expect(Number(db.referral_orders[0].commission_amount)).toBe(COMMISSION);
  });

  it("is idempotent: a second tick finds nothing to do and writes nothing", async () => {
    db.orders = [halfWritten("ONCE")];

    await repairMissingCommissionAccruals({ now: NOW });
    const second = await repairMissingCommissionAccruals({ now: NOW });

    expect(second.mirrorRepaired ?? 0).toBe(0);
    expect(second.failed).toBe(0);
    expect(db.commissions.filter((r) => r.order_id === "ONCE")).toHaveLength(1);
  });

  it("does not report a repair it cannot read back", async () => {
    // The upsert returns success and the row is not there. Reporting
    // `mirrorRepaired` on the strength of "no error" is the same false all-clear
    // that let the half-written accrual sit unrepaired in the first place, and
    // it would ALSO take the order out of the operator's view while the
    // ambassador's commission was still invisible to profit.
    db.orders = [halfWritten("VANISHES")];
    db.mirrorWriteVanishes = true;

    const result = await repairMissingCommissionAccruals({ now: NOW });

    expect(result.mirrorRepaired ?? 0).toBe(0);
    expect(result.failed).toBe(1);
    const alert = db.alerts.find((a) => a.type === "commission_accrual_unrecovered");
    expect(alert).toBeDefined();

    // And it is still a candidate on the next tick, so it repairs itself the
    // moment the write starts landing.
    db.mirrorWriteVanishes = false;
    const next = await repairMissingCommissionAccruals({ now: NOW });
    expect(next.mirrorRepaired).toBe(1);
    expect(stillBroken()).toEqual([]);
  });

  it("refuses to write a mirror the foreign key would reject, and alerts instead", async () => {
    // commissions.partner_id is `not null references partners(id)`. Writing
    // blind would raise 23503 and leave the same half-written state with an
    // extra failed write; the sweep says so and stays repairable.
    db.partners = [];
    db.orders = [halfWritten("NO-PARTNER")];

    const result = await repairMissingCommissionAccruals({ now: NOW });

    expect(result.mirrorRepaired ?? 0).toBe(0);
    expect(result.failed).toBe(1);
    expect(db.commissions).toHaveLength(0);
    const alert = db.alerts.find((a) => a.type === "commission_accrual_unrecovered");
    expect(alert).toBeDefined();
  });
});

describe("convergence under a stream of arrivals, not on a static fixture", () => {
  it("clears a half-written backlog while new orders keep arriving, and then stops", async () => {
    // THE REGRESSION THIS SHAPE EXISTS FOR: a selection fix that is correct on
    // one frozen table and wrong under a stream. Every tick, three more paid
    // referred orders arrive — some healthy, some with nothing, some
    // half-written — while the sweep can only attempt `limit` repairs per tick.
    const backlog = [
      halfWritten("old-a", { paid_at: day(1) }),
      halfWritten("old-b", { paid_at: day(2) }),
      order("old-c", { paid_at: day(3) }),
      halfWritten("old-d", { paid_at: day(4) }),
      order("old-e", { paid_at: day(5) }),
    ];
    db.orders = [...backlog];

    let arrivalDay = 10;
    for (let tick = 0; tick < 6; tick += 1) {
      const result = await repairMissingCommissionAccruals({ now: NOW, limit: 2 });
      expect(result.failed).toBe(0);

      // INVARIANT AFTER EVERY TICK: the sweep never writes a mirror for an
      // order with no ledger row, and never writes two mirrors for one order.
      const ledger = new Set(db.referral_orders.map((r) => String(r.order_id)));
      for (const mirror of db.commissions) expect(ledger.has(String(mirror.order_id))).toBe(true);
      expect(new Set(db.commissions.map((r) => r.order_id)).size).toBe(db.commissions.length);

      // ... and three more paid orders land, as they would in production.
      if (tick < 3) {
        db.orders.push(
          healthy(`new-${tick}-h`, { paid_at: day(arrivalDay) }),
          halfWritten(`new-${tick}-m`, { paid_at: day(arrivalDay + 1) }),
          order(`new-${tick}-n`, { paid_at: day(arrivalDay + 2) }),
        );
        arrivalDay += 3;
      }
    }

    // Arrivals stopped three ticks ago and the sweep has caught up completely.
    expect(stillBroken()).toEqual([]);

    // And the next tick is a genuine no-op — no re-accrual, no re-mirroring.
    const quiet = await repairMissingCommissionAccruals({ now: NOW, limit: 2 });
    expect(quiet.repaired).toBe(0);
    expect(quiet.mirrorRepaired ?? 0).toBe(0);
    expect(quiet.failed).toBe(0);
    expect(db.alerts).toHaveLength(0);
  });

  it("serves the ambassador who has been waiting longest first", async () => {
    // Oldest-first across BOTH kinds of missing obligation. A newly arrived
    // order must never overtake a half-written one from three weeks ago.
    db.orders = [
      order("newest", { paid_at: day(20) }),
      halfWritten("oldest", { paid_at: day(2) }),
      order("middle", { paid_at: day(9) }),
    ];

    const first = await repairMissingCommissionAccruals({ now: NOW, limit: 1 });
    expect(first.deferred).toBe(2);
    expect(db.commissions.map((r) => r.order_id)).toEqual(["oldest"]);

    await repairMissingCommissionAccruals({ now: NOW, limit: 1 });
    expect(accrue.fn.mock.calls.map((call) => (call[0] as Row).order_id)).toEqual(["middle"]);
  });

  it("a half-written order that keeps failing keeps being retried, and keeps alerting", async () => {
    // The whole point: the obligation is real, so it stays in the candidate set
    // until it is actually recorded. It must not alert once and vanish.
    db.partners = [];
    db.orders = [halfWritten("STUCK")];

    for (let tick = 0; tick < 3; tick += 1) {
      const result = await repairMissingCommissionAccruals({ now: NOW });
      expect(result.failed).toBe(1);
    }
    expect(db.alerts.filter((a) => a.type === "commission_accrual_unrecovered")).toHaveLength(3);

    // And the moment the partners row exists, the backlog clears itself.
    db.partners = [{ id: AMBASSADOR }];
    const recovered = await repairMissingCommissionAccruals({ now: NOW });
    expect(recovered.failed).toBe(0);
    expect(recovered.mirrorRepaired).toBe(1);
    expect(stillBroken()).toEqual([]);
  });
});
