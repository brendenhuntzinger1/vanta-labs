import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AFF-3 — A REPAIRED COMMISSION IS AS OLD AS THE ORDER IT PAYS FOR.
//
// autoApproveEligibleCommissions gates the payout hold on
// referral_orders.created_at, and the accrual writes created_at = now. When the
// webhook accrual failed and the sweep wrote the row days later, the 30-day hold
// restarted from the repair, so an ambassador whose commission went missing for
// a week was paid a week late on top of it. The sweep now aligns created_at on
// both ledgers to the order's paid_at, backwards only.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PAID_AT = "2026-08-20T09:30:00.000Z";

const db = vi.hoisted(() => ({
  orders: [] as Row[],
  referral_orders: [] as Row[],
  commissions: [] as Row[],
  alerts: [] as Row[],
}));

/** Stands in for the live accrual: writes both ledgers with created_at = now. */
const accrue = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-webhook", () => ({ accrueCommissionForPaidOrder: accrue }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: Row) => { db.alerts.push(alert); }),
}));

vi.mock("@/lib/supabase-server", () => {
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
    const column = term.slice(0, first);
    const op = term.slice(first + 1, second);
    const value = term.slice(second + 1);
    if (op === "is") return (row[column] ?? null) === null;
    if (op === "gte") return row[column] != null && String(row[column]) >= value;
    throw new Error(`unsupported or() operator: ${op}`);
  }

  function builder(table: string) {
    const rows = (db as unknown as Record<string, Row[]>)[table];
    if (!Array.isArray(rows)) throw new Error(`unexpected table in test: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" = "select";
    let payload: Row | null = null;
    let single = false;
    let from = 0;
    let to = Number.POSITIVE_INFINITY;

    function settle() {
      const hits = rows.filter((row) => filters.every((f) => f(row)));
      if (op === "update") {
        for (const row of hits) Object.assign(row, payload);
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      const page = hits.slice(from, to === Number.POSITIVE_INFINITY ? undefined : to + 1).map((r) => ({ ...r }));
      return single ? { data: page[0] ?? null, error: null } : { data: page, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      update(value: Row) { op = "update"; payload = value; return b; },
      eq(col: string, value: unknown) { filters.push((row) => String(row[col] ?? "") === String(value)); return b; },
      gt(col: string, value: unknown) { filters.push((row) => row[col] != null && String(row[col]) > String(value)); return b; },
      not(col: string, _op: string, _value: unknown) { void _op; void _value; filters.push((row) => (row[col] ?? null) !== null); return b; },
      in(col: string, values: unknown[]) { const set = new Set(values.map(String)); filters.push((row) => set.has(String(row[col]))); return b; },
      or(expr: string) { const terms = splitTop(expr); filters.push((row) => terms.some((t) => evalTerm(row, t))); return b; },
      order() { return b; },
      limit() { return b; },
      range(a: number, z: number) { from = a; to = z; return b; },
      maybeSingle() { single = true; return Promise.resolve(settle()); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(settle()).then(resolve, reject); },
    };
    return b;
  }
  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

const { repairMissingCommissionAccruals } = await import("@/lib/commission-accrual-repair");

beforeEach(() => {
  db.orders = [{
    order_id: "order-late",
    payment_status: "paid",
    ambassador_id: "amb-1",
    referral_code: "AMB1",
    subtotal: 120,
    discount_amount: 0,
    customer_email: "b@example.test",
    shipping_address: null, city: null, postal_code: null,
    paid_at: PAID_AT,
    created_at: PAID_AT,
  }];
  db.referral_orders = [];
  db.commissions = [];
  db.alerts = [];
  accrue.mockReset();
  accrue.mockImplementation(async (order: Row) => {
    // What the live accrual does: rows stamped with the moment of the write.
    db.referral_orders.push({ id: "ro-1", order_id: order.order_id, ambassador_id: "amb-1", payment_status: "pending", commission_amount: 18, created_at: NOW.toISOString() });
    db.commissions.push({ id: "c-1", order_id: order.order_id, partner_id: "amb-1", status: "pending", commission_amount: 18, created_at: NOW.toISOString() });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("repairMissingCommissionAccruals", () => {
  it("dates the repaired accrual from the order's paid_at, not from the repair, on both ledgers", async () => {
    const result = await repairMissingCommissionAccruals({ now: NOW, lookbackDays: 45 });

    expect(result.repaired).toBe(1);
    expect(db.referral_orders[0]?.created_at).toBe(PAID_AT);
    expect(db.commissions[0]?.created_at).toBe(PAID_AT);
  });

  it("never makes a row YOUNGER than it already is", async () => {
    // A paid_at after the row's created_at (clock skew, a manual paid_at edit)
    // must not push the hold out.
    const earlier = "2026-08-01T00:00:00.000Z";
    accrue.mockImplementation(async (order: Row) => {
      db.referral_orders.push({ id: "ro-1", order_id: order.order_id, ambassador_id: "amb-1", payment_status: "pending", commission_amount: 18, created_at: earlier });
      db.commissions.push({ id: "c-1", order_id: order.order_id, partner_id: "amb-1", status: "pending", commission_amount: 18, created_at: earlier });
    });

    await repairMissingCommissionAccruals({ now: NOW, lookbackDays: 45 });

    expect(db.referral_orders[0]?.created_at).toBe(earlier);
    expect(db.commissions[0]?.created_at).toBe(earlier);
  });

  it("leaves the age alone when the order has no paid_at to align to", async () => {
    db.orders[0].paid_at = null;
    await repairMissingCommissionAccruals({ now: NOW, lookbackDays: 45 });

    expect(db.referral_orders[0]?.created_at).toBe(NOW.toISOString());
  });
});
