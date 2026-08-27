import { beforeEach, describe, expect, it, vi } from "vitest";
import { planRefundRepairs } from "@/lib/refund-effect-repair";

// Four refund side-effects share ONE scan over refunded orders. Each is
// selected by its own absence, so an order missing only one of them gets only
// that one repaired. All four are individually idempotent (each has an
// existing-row guard), which is why they are safe to re-run at all.
describe("planRefundRepairs", () => {
  const refunded = {
    order_id: "order-1",
    payment_status: "refunded",
    refund_amount: 0,
    points_earned: 120,
    points_redeemed: 50,
    store_credit_redeemed_cents: 500,
    amount_paid: 4999,
  };

  it("plans every effect when none has run", () => {
    expect(planRefundRepairs(refunded, new Set(), new Set()).sort()).toEqual(
      ["points_restore", "points_reversal", "refund_amount", "store_credit_refund"],
    );
  });

  it("skips refund_amount once it is recorded", () => {
    const plan = planRefundRepairs({ ...refunded, refund_amount: 42.5 }, new Set(), new Set());
    expect(plan).not.toContain("refund_amount");
  });

  it("skips points reversal once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(["order_refund_reversal"]), new Set());
    expect(plan).not.toContain("points_reversal");
  });

  it("skips points restore once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(["order_refund_points_restore"]), new Set());
    expect(plan).not.toContain("points_restore");
  });

  it("skips store credit refund once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(), new Set(["membership_redemption_refund"]));
    expect(plan).not.toContain("store_credit_refund");
  });

  it("plans nothing for an order that earned, redeemed and owed nothing", () => {
    expect(
      planRefundRepairs(
        { ...refunded, refund_amount: 10, points_earned: 0, points_redeemed: 0, store_credit_redeemed_cents: 0 },
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
  });

  it("plans nothing for an order that is not refunded", () => {
    expect(
      planRefundRepairs({ ...refunded, payment_status: "paid" }, new Set(), new Set()),
    ).toEqual([]);
  });

  // FIX ROUND 1 — retry-storm convergence for a legitimately $0 refund.
  //
  // A 100%-discount order that took no money at all can still be marked
  // `refunded` (nothing was ever paid, but the payment lifecycle still
  // resolves to that terminal status). Its refund_amount is 0 not because
  // the effect never ran, but because there is nothing to record. Planning
  // `refund_amount` for it anyway would never converge: the guarded UPDATE
  // (`refund_amount = 0` WHERE `refund_amount = 0`) matches every time,
  // rewrites 0 -> 0, and the sweep would replan and "repair" this same order
  // on every tick forever — an unbounded stream of pointless writes and a
  // `repaired` count that stops meaning "something was actually fixed".
  it("plans no refund_amount for a legitimately $0 refund — this is the convergence proof", () => {
    const zeroDollarOrder = {
      ...refunded,
      amount_paid: 0,
      refund_amount: 0,
      points_earned: 0,
      points_redeemed: 0,
      store_credit_redeemed_cents: 0,
    };
    expect(planRefundRepairs(zeroDollarOrder, new Set(), new Set())).not.toContain("refund_amount");
    // Nothing at all to repair for an order that took no money and earned or
    // redeemed nothing.
    expect(planRefundRepairs(zeroDollarOrder, new Set(), new Set())).toEqual([]);
  });

  // The fix must not disable the effect it exists for: a normal refunded
  // order that DID take money and has no refund_amount recorded yet must
  // still plan refund_amount.
  it("still plans refund_amount for a normal refunded order that took money and has none recorded", () => {
    const plan = planRefundRepairs(
      { ...refunded, amount_paid: 4999, refund_amount: 0 },
      new Set(),
      new Set(),
    );
    expect(plan).toContain("refund_amount");
  });
});

// ---------------------------------------------------------------------------
// THE SWEEP ITSELF, over an in-memory orders/ledger store.
//
// planRefundRepairs proves the selector — which effects are missing for one
// order it is HANDED. It cannot prove the sweep ever FINDS that order, and it
// cannot prove the writes converge. Three separate defects lived in exactly
// that gap:
//
//   1. `.gte("refunded_at", since)` — refunded_at is NULLABLE and `>=` never
//      matches NULL. payment_status='refunded' is written EARLY by
//      upsertOrderRecord; refund_amount AND refunded_at are written together
//      LATER, best-effort, failure swallowed. So the canonical "revenue was
//      never reduced" order has refunded_at IS NULL — and the sweep built to
//      repair it could not see it at all.
//
//   2. The repair stamped refunded_at = now(). That column records WHEN the
//      money went back, and admin-membership.ts attributes 30-day membership
//      refunds by it: a months-old refund was re-dated to today and deducted
//      from the wrong month.
//
//   3. The guarded UPDATE used `.eq("refund_amount", 0)`, which does not match
//      NULL. For a legacy NULL row it matched nothing, returned no error, and
//      `repaired` was incremented anyway — so the order was replanned and
//      "repaired" every tick, forever.
//
// The mock below is a small PostgREST: filters, or(), ordering, limits and
// guarded updates all genuinely apply, so a query that fails to select a row
// really does miss it here.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: {
  orders: Row[];
  points_ledger: Row[];
  store_credit_ledger: Row[];
  beforeOrdersUpdate: null | (() => void);
} = { orders: [], points_ledger: [], store_credit_ledger: [], beforeOrdersUpdate: null };

const effects = vi.hoisted(() => ({
  reverseOrderPoints: vi.fn(),
  restoreRedeemedPoints: vi.fn(),
  refundStoreCreditForOrder: vi.fn(),
  recordSystemAlert: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/membership", () => ({
  reverseOrderPoints: effects.reverseOrderPoints,
  restoreRedeemedPoints: effects.restoreRedeemedPoints,
}));
vi.mock("@/lib/store-credit", () => ({
  refundStoreCreditForOrder: effects.refundStoreCreditForOrder,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: effects.recordSystemAlert }));

vi.mock("@/lib/supabase-server", () => {
  // `col.op.value`, where the value may itself contain dots (an ISO timestamp).
  function term(expression: string): (row: Row) => boolean {
    const first = expression.indexOf(".");
    const second = expression.indexOf(".", first + 1);
    const column = expression.slice(0, first);
    const op = expression.slice(first + 1, second);
    const raw = expression.slice(second + 1);
    const value = raw === "null" ? null : raw;
    return (row) => {
      const actual = row[column] ?? null;
      switch (op) {
        case "is": return actual === value;
        case "eq": return String(actual) === String(value);
        case "gt": return Number(actual ?? 0) > Number(value);
        // NULL never satisfies a range comparison — the whole point of #1.
        case "gte": return actual != null && String(actual) >= String(value);
        default: throw new Error(`unsupported or() operator in test: ${op}`);
      }
    };
  }

  function builder(name: string) {
    const rows = (db as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(rows)) throw new Error(`unexpected table in test: ${name}`);

    const filters: Array<(row: Row) => boolean> = [];
    let action: "select" | "update" = "select";
    let patch: Row = {};
    let sort: { col: string; asc: boolean } | null = null;
    let take: number | null = null;

    function settle() {
      if (action === "update" && name === "orders") db.beforeOrdersUpdate?.();
      const hit = rows.filter((row) => filters.every((f) => f(row)));
      if (action === "update") {
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      }
      let out = hit.map((row) => ({ ...row }));
      if (sort) {
        const { col, asc } = sort;
        out.sort((a, x) => {
          const l = String(a[col] ?? "");
          const r = String(x[col] ?? "");
          return asc ? l.localeCompare(r) : r.localeCompare(l);
        });
      }
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      update(next: Row) { action = "update"; patch = next; return b; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      or(expression: string) {
        const any = expression.split(",").map(term);
        filters.push((row) => any.some((f) => f(row)));
        return b;
      },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return b; },
      order(col: string, opts?: { ascending?: boolean }) { sort = { col, asc: opts?.ascending !== false }; return b; },
      limit(n: number) { take = n; return b; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }

  return { supabaseAdmin: { from: (name: string) => builder(name) } };
});

import { repairIncompleteRefunds } from "@/lib/refund-effect-repair";

const ORDER_ID = "order-1";

function refundedOrder(overrides: Row = {}): Row {
  return {
    id: "row-1",
    order_id: ORDER_ID,
    payment_status: "refunded",
    refund_amount: 0,
    points_earned: 0,
    points_redeemed: 0,
    store_credit_redeemed_cents: 0,
    amount_paid: 4999,
    refunded_at: null,
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orders = [];
  db.points_ledger = [];
  db.store_credit_ledger = [];
  db.beforeOrdersUpdate = null;
  // Each effect writes its own ledger row the first time, exactly as the real
  // functions do, so the SECOND run's absence check reads state the first run
  // genuinely produced.
  effects.reverseOrderPoints.mockImplementation(async (orderId: string) => {
    if (db.points_ledger.some((r) => r.order_id === orderId && r.reason === "order_refund_reversal")) return;
    db.points_ledger.push({ order_id: orderId, reason: "order_refund_reversal" });
  });
  effects.restoreRedeemedPoints.mockImplementation(async (orderId: string) => {
    if (db.points_ledger.some((r) => r.order_id === orderId && r.reason === "order_refund_points_restore")) return;
    db.points_ledger.push({ order_id: orderId, reason: "order_refund_points_restore" });
  });
  effects.refundStoreCreditForOrder.mockImplementation(async (orderId: string) => {
    if (db.store_credit_ledger.some((r) => r.order_id === orderId && r.reason === "membership_redemption_refund")) return;
    db.store_credit_ledger.push({ order_id: orderId, reason: "membership_redemption_refund" });
  });
});

describe("a refunded order that never got a refunded_at", () => {
  // THE PRIMARY CASE. payment_status flips to 'refunded' first; refund_amount
  // and refunded_at land later in a best-effort write whose failure is
  // swallowed. An order stranded between those two writes is precisely the
  // "revenue was never reduced" order this sweep exists for — and `>=` on a
  // NULL column made it invisible.
  it("is selected and repaired", async () => {
    db.orders = [refundedOrder({ refunded_at: null, refund_amount: 0 })];

    const result = await repairIncompleteRefunds();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].refund_amount).toBe(4999);
  });

  it("is not given an invented refund date", async () => {
    db.orders = [refundedOrder({ refunded_at: null, refund_amount: 0 })];
    await repairIncompleteRefunds();
    // The repair knows the AMOUNT that was missed, never the DATE.
    expect(db.orders[0].refunded_at).toBeNull();
  });

  it("converges: the second tick no longer sees it", async () => {
    db.orders = [refundedOrder({ refunded_at: null, refund_amount: 0 })];
    await repairIncompleteRefunds();
    const second = await repairIncompleteRefunds();
    expect(second).toEqual({ scanned: 0, repaired: 0, failed: 0 });
  });
});

describe("an existing refunded_at", () => {
  // admin-membership.ts attributes 30-day membership refunds BY this column.
  // Re-stamping a February refund as today deducts it from August.
  it("is left exactly as it was", async () => {
    const when = "2026-02-11T14:03:00Z";
    db.orders = [refundedOrder({ refunded_at: when, refund_amount: 0 })];

    // A wide window on purpose: the refund really is months old, which is the
    // only shape in which the re-stamping bug moves money to the wrong month.
    const result = await repairIncompleteRefunds({
      lookbackDays: 365,
      now: new Date("2026-08-26T00:00:00Z"),
    });

    expect(result.repaired).toBe(1);
    expect(db.orders[0].refund_amount).toBe(4999);
    expect(db.orders[0].refunded_at).toBe(when);
  });
});

describe("the NULL-vs-0 guard on the refund_amount claim", () => {
  it("repairs a legacy NULL refund_amount", async () => {
    db.orders = [refundedOrder({ refund_amount: null })];

    const result = await repairIncompleteRefunds();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].refund_amount).toBe(4999);
  });

  it("repairs a refund_amount of 0", async () => {
    db.orders = [refundedOrder({ refund_amount: 0 })];

    const result = await repairIncompleteRefunds();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].refund_amount).toBe(4999);
  });

  it("does NOT count a repair when the guarded update matched no row", async () => {
    db.orders = [refundedOrder({ refund_amount: 0 })];
    // Another writer records the refund between the plan and the claim, so the
    // compare-and-set matches nothing. Counting that as `repaired` is what let
    // the retry storm sustain itself: a row that is never actually written
    // stays selectable and is "repaired" again on every tick.
    db.beforeOrdersUpdate = () => { db.orders[0].refund_amount = 1234; };

    const result = await repairIncompleteRefunds();

    expect(result).toEqual({ scanned: 1, repaired: 0, failed: 0 });
    expect(db.orders[0].refund_amount).toBe(1234);
  });
});

describe("repairIncompleteRefunds — running twice over the same order", () => {
  it("repairs all four effects on the first run, then performs no further writes on the second", async () => {
    db.orders = [refundedOrder({
      refund_amount: 0,
      points_earned: 120,
      points_redeemed: 50,
      store_credit_redeemed_cents: 500,
      refunded_at: "2026-08-20T00:00:00Z",
    })];

    const first = await repairIncompleteRefunds();
    expect(first).toEqual({ scanned: 1, repaired: 4, failed: 0 });
    expect(effects.reverseOrderPoints).toHaveBeenCalledTimes(1);
    expect(effects.restoreRedeemedPoints).toHaveBeenCalledTimes(1);
    expect(effects.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
    expect(db.orders[0].refund_amount).toBe(4999);
    expect(db.points_ledger).toEqual([
      { order_id: ORDER_ID, reason: "order_refund_reversal" },
      { order_id: ORDER_ID, reason: "order_refund_points_restore" },
    ]);
    expect(db.store_credit_ledger).toEqual([
      { order_id: ORDER_ID, reason: "membership_redemption_refund" },
    ]);

    // Still scanned by the ledger-effects pass (it earned points), but every
    // effect is now present, so nothing is planned and nothing is written.
    const second = await repairIncompleteRefunds();
    expect(second).toEqual({ scanned: 1, repaired: 0, failed: 0 });
    expect(effects.reverseOrderPoints).toHaveBeenCalledTimes(1);
    expect(effects.restoreRedeemedPoints).toHaveBeenCalledTimes(1);
    expect(effects.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
  });

  // The ledger-effects pass is what keeps points and store credit reachable on
  // an order whose refund_amount was already correct — the case the
  // refund_amount pushdown alone would have dropped.
  it("still reverses points on an order whose refund_amount was already recorded", async () => {
    db.orders = [refundedOrder({ refund_amount: 4999, points_earned: 120, refunded_at: "2026-08-20T00:00:00Z" })];

    const result = await repairIncompleteRefunds();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(effects.reverseOrderPoints).toHaveBeenCalledTimes(1);
  });
});
