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
    // Points live on an ACCOUNT. An order that earned or redeemed any must
    // have one, so the fixture carries it.
    customer_user_id: "user-1",
  };

  it("plans every effect when none has run", () => {
    // The `redeem` reason is the PROOF the points were ever debited — see the
    // points_restore tests below. Without it there is nothing to give back.
    expect(planRefundRepairs(refunded, new Set(["redeem"]), new Set()).sort()).toEqual(
      ["points_restore", "points_reversal", "refund_amount", "store_credit_refund"],
    );
  });

  // FIX WAVE 3 — POINTS ARE RESTORED FROM THE LEDGER, NOT FROM THE ORDER.
  //
  // orders.points_redeemed is what checkout INTENDED to spend, written before
  // any debit is attempted. redeemPoints is skipped for a guest or a membership
  // order, clamps down to the live balance, and — when it fails — is explicitly
  // classified alert-only and survivable, so the order proceeds. Planning the
  // restore from the order column therefore handed a customer points that were
  // never taken from them, automatically, across a 90-day backlog of refunds,
  // on top of a full cash refund.
  it("plans NO points_restore when the ledger holds no matching debit", () => {
    const plan = planRefundRepairs(refunded, new Set(), new Set());
    expect(plan).not.toContain("points_restore");
  });

  it("plans points_restore only once a `redeem` debit is on file", () => {
    expect(planRefundRepairs(refunded, new Set(["redeem"]), new Set())).toContain("points_restore");
  });

  it("still skips points_restore once the restore itself is on file", () => {
    const plan = planRefundRepairs(refunded, new Set(["redeem", "order_refund_points_restore"]), new Set());
    expect(plan).not.toContain("points_restore");
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
    const plan = planRefundRepairs(refunded, new Set(["redeem", "order_refund_points_restore"]), new Set());
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

  // FIX ROUND 2 — a repair that can NEVER write anything is terminal, not
  // pending. Both points effects return early when the order has no
  // customer_user_id (reverseOrderPoints / restoreRedeemedPoints), so planning
  // them for a guest order calls a function that does nothing, counts a
  // "repair", and plans it again on the next tick. Forever.
  it("plans no points effect for a guest order that has no account to credit", () => {
    const guest = { ...refunded, customer_user_id: null, refund_amount: 4999, store_credit_redeemed_cents: 0 };
    expect(planRefundRepairs(guest, new Set(), new Set())).toEqual([]);
  });

  // Same shape for store credit: refundStoreCreditForOrder declines a
  // redemption spent in a PRIOR month (the credit has expired) and writes
  // nothing, so "no membership_redemption_refund row" stays true forever.
  it("plans no store credit refund when no recorded redemption is still refundable", () => {
    const expired = { ...refunded, refund_amount: 4999, points_earned: 0, points_redeemed: 0 };
    expect(
      planRefundRepairs(expired, new Set(), new Set(), { storeCreditRefundable: false }),
    ).toEqual([]);
    // ...and still plans it when the redemption IS refundable, so the fix does
    // not disable the effect it exists for.
    expect(
      planRefundRepairs(expired, new Set(), new Set(), { storeCreditRefundable: true }),
    ).toEqual(["store_credit_refund"]);
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
vi.mock("@/lib/store-credit", async () => {
  // isRefundableRedemption and startOfCurrentMonthIso are pure date/amount
  // rules — the sweep must use the REAL ones, or the expired-credit test would
  // only be proving the mock.
  const real = await vi.importActual<typeof import("@/lib/store-credit")>("@/lib/store-credit");
  return {
    isRefundableRedemption: real.isRefundableRedemption,
    startOfCurrentMonthIso: real.startOfCurrentMonthIso,
    refundStoreCreditForOrder: effects.refundStoreCreditForOrder,
  };
});
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: effects.recordSystemAlert }));

vi.mock("@/lib/supabase-server", () => {
  /**
   * Split a PostgREST or()/and() argument on its TOP-LEVEL commas only, so a
   * nested `and(a,b)` group survives as one term. Splitting blindly turned
   * `and(refunded_at.is.null,updated_at.gte.X)` into the nonsense column
   * "and(refunded_at" — which matched EVERY row, and quietly made this whole
   * double stop filtering.
   */
  function splitTerms(expression: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of expression) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += char;
    }
    if (current) parts.push(current);
    return parts;
  }

  // `col.op.value`, where the value may itself contain dots (an ISO timestamp),
  // or a nested `and(...)` group.
  function term(expression: string): (row: Row) => boolean {
    if (expression.startsWith("and(") && expression.endsWith(")")) {
      const all = splitTerms(expression.slice(4, -1)).map(term);
      return (row) => all.every((f) => f(row));
    }
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
    const sortKeys: Array<{ col: string; asc: boolean }> = [];
    let take: number | null = null;
    let skip = 0;

    function settle() {
      if (action === "update" && name === "orders") db.beforeOrdersUpdate?.();
      const hit = rows.filter((row) => filters.every((f) => f(row)));
      if (action === "update") {
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      }
      let out = hit.map((row) => ({ ...row }));
      if (sortKeys.length > 0) {
        // Multi-key ordering, because paging is only deterministic with a
        // tiebreak: two rows sharing an updated_at must still have ONE order.
        out.sort((a, x) => {
          for (const { col, asc } of sortKeys) {
            const l = String(a[col] ?? "");
            const r = String(x[col] ?? "");
            const cmp = l.localeCompare(r);
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
      update(next: Row) { action = "update"; patch = next; return b; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      or(expression: string) {
        const any = splitTerms(expression).map(term);
        filters.push((row) => any.some((f) => f(row)));
        return b;
      },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return b; },
      order(col: string, opts?: { ascending?: boolean }) { sortKeys.push({ col, asc: opts?.ascending !== false }); return b; },
      limit(n: number) { take = n; return b; },
      // Offset paging, as PostgREST implements .range(): inclusive on both ends.
      range(from: number, to: number) { skip = from; take = to - from + 1; return b; },
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
    customer_user_id: "user-1",
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
  // Each returns WHETHER IT WROTE, exactly as the real functions now do — a
  // no-op is not a repair.
  effects.reverseOrderPoints.mockImplementation(async (orderId: string) => {
    if (db.points_ledger.some((r) => r.order_id === orderId && r.reason === "order_refund_reversal")) return false;
    db.points_ledger.push({ order_id: orderId, reason: "order_refund_reversal" });
    return true;
  });
  effects.restoreRedeemedPoints.mockImplementation(async (orderId: string) => {
    if (db.points_ledger.some((r) => r.order_id === orderId && r.reason === "order_refund_points_restore")) return false;
    db.points_ledger.push({ order_id: orderId, reason: "order_refund_points_restore" });
    return true;
  });
  effects.refundStoreCreditForOrder.mockImplementation(async (orderId: string) => {
    if (db.store_credit_ledger.some((r) => r.order_id === orderId && r.reason === "membership_redemption_refund")) return false;
    db.store_credit_ledger.push({ order_id: orderId, reason: "membership_redemption_refund" });
    return true;
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

  it("converges: the second tick plans nothing and writes nothing", async () => {
    db.orders = [refundedOrder({ refunded_at: null, refund_amount: 0 })];
    await repairIncompleteRefunds();
    const before = JSON.stringify(db.orders);

    const second = await repairIncompleteRefunds();

    // `scanned` counts rows READ from the window, and a repaired order is
    // still a refunded order inside it — so it is read again and found to need
    // nothing. What must not happen is another write or another counted repair.
    expect(second.repaired).toBe(0);
    expect(second.failed).toBe(0);
    expect(JSON.stringify(db.orders)).toBe(before);
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
    // The points debit this refund gives back. Without a `redeem` row on file
    // nothing was ever taken, and points_restore is correctly not planned —
    // same rule as the store-credit redemption below.
    db.points_ledger = [{ order_id: ORDER_ID, reason: "redeem" }];
    // The redemption this refund returns. Without a redemption row on file
    // there is nothing for refundStoreCreditForOrder to give back, and the
    // effect is correctly not planned at all.
    db.store_credit_ledger = [{
      order_id: ORDER_ID,
      reason: "membership_redemption",
      amount_cents: -500,
      created_at: new Date().toISOString(),
    }];

    const first = await repairIncompleteRefunds();
    expect(first).toEqual({ scanned: 1, repaired: 4, failed: 0 });
    expect(effects.reverseOrderPoints).toHaveBeenCalledTimes(1);
    expect(effects.restoreRedeemedPoints).toHaveBeenCalledTimes(1);
    expect(effects.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
    expect(db.orders[0].refund_amount).toBe(4999);
    expect(db.points_ledger).toEqual([
      { order_id: ORDER_ID, reason: "redeem" },
      { order_id: ORDER_ID, reason: "order_refund_reversal" },
      { order_id: ORDER_ID, reason: "order_refund_points_restore" },
    ]);
    expect(db.store_credit_ledger.filter((row) => row.reason === "membership_redemption_refund")).toEqual([
      { order_id: ORDER_ID, reason: "membership_redemption_refund" },
    ]);

    // Still read from the window, but every effect is now present, so nothing
    // is planned and nothing is written.
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

// ---------------------------------------------------------------------------
// THE SWEEP MUST ADVANCE. This is the test that did not exist, and the gap
// three separate non-convergence defects lived in.
//
// `limit` bounds WORK, not READS. Three of the four effects are proven missing
// by the ABSENCE OF A ROW IN ANOTHER TABLE, which no `orders` predicate can
// express — so a query that returns the oldest `limit` refunded orders and then
// decides in JavaScript returns the SAME rows on every tick when those rows
// need nothing. The order behind them is never selected. Not late: never.
//
// Every test below therefore puts MORE rows in the window than `limit` allows,
// with the row that actually needs repair LAST.
// ---------------------------------------------------------------------------
describe("a window with more rows than `limit`", () => {
  function filler(n: number, overrides: Row = {}): Row[] {
    return Array.from({ length: n }, (_, i) => refundedOrder({
      id: `row-fill-${i}`,
      order_id: `filler-${i}`,
      // Oldest first, so every filler sorts AHEAD of the broken order.
      updated_at: `2026-08-0${i + 1}T00:00:00Z`,
      ...overrides,
    }));
  }

  it("reaches the broken order sitting behind a full window of already-correct ones", async () => {
    // Five refunded orders that earned points and were correctly reversed.
    // They match every narrowing an `orders` query can express, they are never
    // written to, so their updated_at never moves — they held the head of the
    // queue forever.
    const correct = filler(5, { refund_amount: 4999, points_earned: 120 });
    for (const order of correct) {
      db.points_ledger.push({ order_id: order.order_id, reason: "order_refund_reversal" });
    }
    const broken = refundedOrder({
      id: "row-broken",
      order_id: "order-broken",
      updated_at: "2026-08-20T00:00:00Z",
      refund_amount: 4999,
      points_earned: 120,
    });
    db.orders = [...correct, broken];

    // A limit far smaller than the number of rows in front of the broken one.
    const result = await repairIncompleteRefunds({ limit: 2 });

    expect(effects.reverseOrderPoints).toHaveBeenCalledWith("order-broken");
    expect(result.repaired).toBe(1);
    // Every row in the window was read to get there — `limit` bounded the
    // repair, not the scan.
    expect(result.scanned).toBe(6);
  });

  it("is not blocked by $0-paid refunded orders that can never be repaired", async () => {
    // A fully-comped order marked refunded: amount_paid 0 and refund_amount 0.
    // It matches "refund_amount is null or 0" forever and is never written to.
    db.orders = [
      ...filler(4, { amount_paid: 0, refund_amount: 0 }),
      refundedOrder({ id: "row-real", order_id: "order-real", updated_at: "2026-08-20T00:00:00Z", refund_amount: 0 }),
    ];

    const result = await repairIncompleteRefunds({ limit: 2 });

    expect(result.repaired).toBe(1);
    expect(db.orders.find((row) => row.order_id === "order-real")!.refund_amount).toBe(4999);
    // The comped orders were read and left alone — no write, no counted repair.
    for (const row of db.orders.filter((r) => r.amount_paid === 0)) {
      expect(row.refund_amount).toBe(0);
    }
  });

  it("is not blocked by orders whose only outstanding effect can never write", async () => {
    // Expired store credit and a guest order's points: both are repairs that
    // legitimately do nothing, so both used to be replanned every tick AND
    // counted as repaired.
    const expiredCredit = filler(3, { refund_amount: 4999, store_credit_redeemed_cents: 500 });
    for (const order of expiredCredit) {
      db.store_credit_ledger.push({
        order_id: order.order_id,
        reason: "membership_redemption",
        amount_cents: -500,
        created_at: "2000-01-05T00:00:00Z", // spent in a long-gone month: expired
      });
    }
    const guest = refundedOrder({
      id: "row-guest",
      order_id: "order-guest",
      updated_at: "2026-08-06T00:00:00Z",
      refund_amount: 4999,
      customer_user_id: null,
      points_earned: 120,
    });
    const broken = refundedOrder({
      id: "row-broken",
      order_id: "order-broken",
      updated_at: "2026-08-20T00:00:00Z",
      refund_amount: 0,
    });
    db.orders = [...expiredCredit, guest, broken];

    const result = await repairIncompleteRefunds({ limit: 2 });

    expect(result.repaired).toBe(1);
    expect(db.orders.find((row) => row.order_id === "order-broken")!.refund_amount).toBe(4999);
    // Neither dead-end effect was even attempted.
    expect(effects.refundStoreCreditForOrder).not.toHaveBeenCalled();
    expect(effects.reverseOrderPoints).not.toHaveBeenCalled();
  });

  it("pages past a full page of rows that need nothing", async () => {
    // SCAN_PAGE_SIZE is 200. A window larger than one page must still reach
    // the row on the second page.
    db.orders = [
      ...filler(0),
      ...Array.from({ length: 250 }, (_, i) => refundedOrder({
        id: `row-ok-${i}`,
        order_id: `ok-${String(i).padStart(4, "0")}`,
        updated_at: `2026-08-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
        refund_amount: 4999,
      })),
      refundedOrder({ id: "row-last", order_id: "zzz-last", updated_at: "2026-08-25T00:00:00Z", refund_amount: 0 }),
    ];

    const result = await repairIncompleteRefunds({ limit: 5 });

    expect(result.repaired).toBe(1);
    expect(db.orders.find((row) => row.order_id === "zzz-last")!.refund_amount).toBe(4999);
    expect(result.scanned).toBe(251);
  });
});

// ---------------------------------------------------------------------------
// A REPAIR THAT WRITES NOTHING IS NOT A REPAIR.
//
// `repaired` is the number the operator reads as "something was fixed". An
// effect that correctly declines to write — expired store credit, a guest
// order's points — must never appear in it, and must never be replanned on the
// next tick either. Reporting `repaired: 1` every thirty minutes forever for a
// function that writes nothing is the same storm the refund_amount guard fixed.
// ---------------------------------------------------------------------------
describe("an effect that can never write", () => {
  it("does not count expired store credit as a repair, on this tick or any later one", async () => {
    db.orders = [refundedOrder({ refund_amount: 4999, store_credit_redeemed_cents: 500 })];
    db.store_credit_ledger = [{
      order_id: ORDER_ID,
      reason: "membership_redemption",
      amount_cents: -500,
      created_at: "2000-01-05T00:00:00Z",
    }];

    const first = await repairIncompleteRefunds();
    const second = await repairIncompleteRefunds();

    expect(first.repaired).toBe(0);
    expect(second.repaired).toBe(0);
    expect(effects.refundStoreCreditForOrder).not.toHaveBeenCalled();
  });

  it("does not count a store credit refund that returned nothing", async () => {
    // Belt and braces: even when the planner cannot tell (the redemption looks
    // refundable), the function's own report of "I wrote nothing" is what the
    // counter follows.
    db.orders = [refundedOrder({ refund_amount: 4999, store_credit_redeemed_cents: 500 })];
    db.store_credit_ledger = [{
      order_id: ORDER_ID,
      reason: "membership_redemption",
      amount_cents: -500,
      created_at: new Date().toISOString(),
    }];
    effects.refundStoreCreditForOrder.mockResolvedValueOnce(false);

    const result = await repairIncompleteRefunds();

    expect(effects.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("does not plan points effects for a guest order, ever", async () => {
    db.orders = [refundedOrder({ refund_amount: 4999, customer_user_id: null, points_earned: 120, points_redeemed: 50 })];

    const first = await repairIncompleteRefunds();
    const second = await repairIncompleteRefunds();

    expect(first.repaired).toBe(0);
    expect(second.repaired).toBe(0);
    expect(effects.reverseOrderPoints).not.toHaveBeenCalled();
    expect(effects.restoreRedeemedPoints).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE SCAN WINDOW IS A WINDOW AGAIN — FIX WAVE 3.
//
// `refunded_at.is.null` was UNBOUNDED by the lookback: a refund from 2020 sat
// inside a one-day window. And the refund_amount repair deliberately never
// stamps refunded_at, so every order this sweep touched stayed in scope
// forever. New refunds sort at the BACK of `ORDER BY updated_at ASC`, behind
// that entire accumulated history — so once it passed the 5000-row scan
// ceiling, a brand-new incomplete refund became permanently unreachable, and
// the `scanTruncated` flag that would have said so had no consumer anywhere in
// the repository.
// ---------------------------------------------------------------------------
describe("the lookback window bounds BOTH disjuncts", () => {
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  it("leaves behind a refunded_at-NULL order that has not been touched in the lookback", async () => {
    db.orders = [refundedOrder({ order_id: "ancient", refunded_at: null, updated_at: old })];

    const result = await repairIncompleteRefunds({ lookbackDays: 90 });

    expect(result.scanned).toBe(0);
    expect(db.orders[0].refund_amount).toBe(0);
  });

  it("still selects the PRIMARY case: refunded now, refunded_at never written", async () => {
    db.orders = [refundedOrder({ order_id: "today", refunded_at: null, updated_at: recent })];

    const result = await repairIncompleteRefunds({ lookbackDays: 90 });

    expect(result).toMatchObject({ scanned: 1, repaired: 1 });
    expect(db.orders[0].refund_amount).toBe(4999);
  });

  it("still selects an order whose refunded_at IS inside the window", async () => {
    db.orders = [refundedOrder({ order_id: "dated", refunded_at: recent, updated_at: old })];

    const result = await repairIncompleteRefunds({ lookbackDays: 90 });

    expect(result).toMatchObject({ scanned: 1, repaired: 1 });
  });
});

describe("hitting the scan ceiling", () => {
  /** Correct, already-repaired refunds: read, plan nothing, and go on forever. */
  function inertRefunds(count: number, prefix: string): Row[] {
    return Array.from({ length: count }, (_, index) => refundedOrder({
      id: `${prefix}-${index}`,
      order_id: `${prefix}-${index}`,
      refund_amount: 4999,
      // Sorted before the victim below, so they are read first.
      updated_at: `2026-08-01T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(4, "0")}Z`,
    }));
  }

  it("does not cry truncation when the whole window was in fact scanned", async () => {
    db.orders = inertRefunds(5000, "inert");

    const result = await repairIncompleteRefunds();

    expect(result.scanned).toBe(5000);
    expect(result.scanTruncated).toBeUndefined();
    expect(effects.recordSystemAlert).not.toHaveBeenCalled();
  });

  it("raises a CRITICAL alert when rows really are left unread", async () => {
    db.orders = [
      ...inertRefunds(5000, "inert"),
      refundedOrder({ id: "victim", order_id: "victim", refund_amount: 0, updated_at: "2026-08-02T00:00:00Z" }),
    ];

    const result = await repairIncompleteRefunds();

    expect(result.scanTruncated).toBe(true);
    // The whole finding: this flag was returned and nobody read it, so the one
    // condition under which the scan cannot reach a row that needs repair was
    // silent in practice.
    const alerted = (effects.recordSystemAlert.mock.calls as unknown as Array<[{ type: string; severity: string }]>)
      .map((call) => call[0]);
    expect(alerted.map((a) => a.type)).toContain("refund_scan_truncated");
    expect(alerted.find((a) => a.type === "refund_scan_truncated")!.severity).toBe("critical");
  });
});
