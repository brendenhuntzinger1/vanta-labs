import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A GUARD THAT CANNOT READ IS NOT A GUARD THAT FOUND NOTHING.
//
// Absence-based repair — which is what this whole branch is built on — is only
// sound while "I could not read" is distinguishable from "it is not there". In
// PostgREST it is not, unless somebody looks: supabase-js does NOT throw for a
// statement timeout (57014), a pooler 503 or a schema-cache miss (PGRST204). It
// resolves `{ data: null, error }`. Every site below used to destructure only
// `{ data }` and drop the error, so one transient failure read as ABSENCE and
// the guarded effect ran again:
//
//   store credit    the already-refunded check failed open -> DOUBLE credit
//   points          the same, twice, plus the INSERT'S OWN error discarded
//   memberships     revocation reported success having changed nothing
//   shipping cost   the voided-label refusal skipped -> refunded postage charged
//
// None of these needs concurrency. One blip is enough, and the sweep counted
// every one of them as `repaired` with `failed: 0`, so no alert ever fired.
//
// These drive the REAL functions against a Postgres-faithful double whose reads
// and writes can be told to fail exactly the way PostgREST fails.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

interface FailRule {
  table: string;
  op: "select" | "insert" | "update";
  /** Narrow to one query on a table several reads share. */
  where?: (filters: Filter[]) => boolean;
  error: { code: string; message: string };
}

const db: { tables: Record<string, Row[]>; fail: FailRule[] } = { tables: {}, fail: [] };

const TIMEOUT_ERROR = { code: "57014", message: "canceling statement due to statement timeout" };

function ruleFor(table: string, op: FailRule["op"], filters: Filter[]) {
  return db.fail.find(
    (rule) => rule.table === table && rule.op === op && (rule.where ? rule.where(filters) : true),
  );
}

function matches(row: Row, filters: Filter[]) {
  return filters.every(([op, column, value]) => {
    const held = row[column] ?? null;
    if (op === "eq") return held === value;
    if (op === "is") return held === value;
    if (op === "gte") return String(held ?? "") >= String(value ?? "");
    return true;
  });
}

function selectBuilder(table: string) {
  const filters: Filter[] = [];
  const rows = () => (db.tables[table] ?? []).filter((row) => matches(row, filters));
  const settle = (limit?: number) => {
    const rule = ruleFor(table, "select", filters);
    if (rule) return { data: null, error: rule.error };
    const found = rows();
    return { data: limit == null ? found : found.slice(0, limit), error: null };
  };
  const builder: Record<string, unknown> = {
    eq(column: string, value: unknown) { filters.push(["eq", column, value]); return builder; },
    is(column: string, value: unknown) { filters.push(["is", column, value]); return builder; },
    in() { return builder; },
    gte(column: string, value: unknown) { filters.push(["gte", column, value]); return builder; },
    order() { return builder; },
    limit: async (n: number) => settle(n),
    // PostgREST's Range, inclusive at both ends. Needed since the tier count
    // began paging; a stub that ignored it would hand the pager the same page
    // forever.
    range: async (from: number, to: number) => {
      const result = settle();
      if (result.error) return result;
      return { data: (result.data ?? []).slice(from, to + 1), error: null };
    },
    // PostgREST returns PGRST116 for maybeSingle() when MORE THAN ONE row
    // matches — the behaviour that turned the first duplicate into a
    // permanently disabled guard.
    maybeSingle: async () => {
      const rule = ruleFor(table, "select", filters);
      if (rule) return { data: null, error: rule.error };
      const found = rows();
      if (found.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" } };
      }
      return { data: found[0] ?? null, error: null };
    },
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
  };
  return builder;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getControlSnapshot: async () => ({}),
  getProfitSettings: async () => ({
    minProfitPercent: 0, minProfitDollars: 0, worstCaseUnitCost: 33,
    processingFeePercent: 8, processingFeeIncludesTax: true,
    countSalesTaxAsProfit: false, shippingCostPerOrder: 6,
  }),
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => selectBuilder(table),
      insert: async (rows: Row | Row[]) => {
        const rule = ruleFor(table, "insert", []);
        if (rule) return { data: null, error: rule.error };
        db.tables[table] = [...(db.tables[table] ?? []), ...(Array.isArray(rows) ? rows : [rows])];
        return { data: null, error: null };
      },
      update: (patch: Row) => {
        const filters: Filter[] = [];
        const apply = () => {
          const rule = ruleFor(table, "update", filters);
          if (rule) return { data: null, error: rule.error };
          const touched = (db.tables[table] ?? []).filter((row) => matches(row, filters));
          for (const row of touched) Object.assign(row, patch);
          return { data: touched.map((row) => ({ order_id: row.order_id, user_id: row.user_id })), error: null };
        };
        const builder: Record<string, unknown> = {
          eq(column: string, value: unknown) { filters.push(["eq", column, value]); return builder; },
          is(column: string, value: unknown) { filters.push(["is", column, value]); return builder; },
          select: async () => apply(),
          then(resolve: (value: unknown) => unknown) {
            const outcome = apply();
            return Promise.resolve({ data: null, error: outcome.error }).then(resolve);
          },
        };
        return builder;
      },
    }),
  },
}));

const { reverseOrderPoints, restoreRedeemedPoints, redeemPoints, getPointsBalance } = await import("@/lib/membership");
const { refundStoreCreditForOrder } = await import("@/lib/store-credit");
const { getEffectiveCommissionPercent } = await import("@/lib/ambassador-commission");

const ORDER = "order-guard-1";
const USER = "user-guard-1";
const AMBASSADOR = "amb-guard-1";

beforeEach(() => {
  db.tables = {
    orders: [{ order_id: ORDER, customer_user_id: USER, points_earned: 120, points_redeemed: 500 }],
    points_ledger: [],
    store_credit_ledger: [],
    ambassadors: [{ id: AMBASSADOR, commission_percent: 25, commission_percent_locked: true }],
    commission_tier_rules: [
      { id: "t1", name: "base", min_monthly_sales: 0, commission_percent: 10, position: 1, is_active: true },
    ],
    referral_orders: [],
  };
  db.fail = [];
});

describe("store credit — the already-refunded guard", () => {
  const redemption = () => ({
    order_id: ORDER, user_id: USER, reason: "membership_redemption",
    amount_cents: -500, created_at: new Date().toISOString(),
  });

  it("returns the credit exactly once", async () => {
    db.tables.store_credit_ledger = [redemption()];

    expect(await refundStoreCreditForOrder(ORDER)).toBe(true);
    expect(await refundStoreCreditForOrder(ORDER)).toBe(false);

    const refunds = db.tables.store_credit_ledger.filter((r) => r.reason === "membership_redemption_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount_cents).toBe(500);
  });

  it("REFUSES rather than double-credits when the guard read fails", async () => {
    db.tables.store_credit_ledger = [redemption(), {
      order_id: ORDER, user_id: USER, reason: "membership_redemption_refund",
      amount_cents: 500, created_at: new Date().toISOString(),
    }];
    db.fail = [{
      table: "store_credit_ledger", op: "select", error: TIMEOUT_ERROR,
      where: (filters) => filters.some(([, c, v]) => c === "reason" && v === "membership_redemption_refund"),
    }];

    await expect(refundStoreCreditForOrder(ORDER)).rejects.toMatchObject({ code: "57014" });

    // The customer is credited once, not twice.
    expect(db.tables.store_credit_ledger.filter((r) => r.reason === "membership_redemption_refund")).toHaveLength(1);
  });

  it("never reports success for an INSERT that was rejected", async () => {
    db.tables.store_credit_ledger = [redemption()];
    db.fail = [{ table: "store_credit_ledger", op: "insert", error: { code: "23503", message: "insert violates foreign key" } }];

    // Returning `true` here made the sweep count `repaired`, leave `failed` at
    // 0 so no alert fired, and — because the row it looks for still did not
    // exist — replan the identical repair on every tick, forever.
    await expect(refundStoreCreditForOrder(ORDER)).rejects.toMatchObject({ code: "23503" });
    expect(db.tables.store_credit_ledger.filter((r) => r.reason === "membership_redemption_refund")).toHaveLength(0);
  });
});

describe("loyalty points — the three SELECT-then-INSERT guards", () => {
  it("reverses an order's earned points exactly once", async () => {
    expect(await reverseOrderPoints(ORDER)).toBe(true);
    expect(await reverseOrderPoints(ORDER)).toBe(false);
    expect(db.tables.points_ledger.filter((r) => r.reason === "order_refund_reversal")).toHaveLength(1);
  });

  it("REFUSES rather than double-debits when the reversal guard read fails", async () => {
    db.tables.points_ledger = [{ order_id: ORDER, user_id: USER, reason: "order_refund_reversal", amount: -120 }];
    db.fail = [{
      table: "points_ledger", op: "select", error: TIMEOUT_ERROR,
      where: (filters) => filters.some(([, c, v]) => c === "reason" && v === "order_refund_reversal"),
    }];

    await expect(reverseOrderPoints(ORDER)).rejects.toMatchObject({ code: "57014" });
    expect(db.tables.points_ledger.filter((r) => r.reason === "order_refund_reversal")).toHaveLength(1);
  });

  // maybeSingle() returns PGRST116 when MORE THAN ONE row matches, so the old
  // guard was permanently disabled by its own first duplicate and every later
  // call added another row. `.limit(1)` cannot fail that way.
  it("still refuses once a historical duplicate exists", async () => {
    db.tables.points_ledger = [
      { order_id: ORDER, user_id: USER, reason: "order_refund_reversal", amount: -120 },
      { order_id: ORDER, user_id: USER, reason: "order_refund_reversal", amount: -120 },
    ];

    expect(await reverseOrderPoints(ORDER)).toBe(false);
    expect(db.tables.points_ledger).toHaveLength(2);
  });

  it("REFUSES rather than double-debits when the redemption guard read fails", async () => {
    db.tables.points_ledger = [{ order_id: ORDER, user_id: USER, reason: "redeem", amount: -500 }];
    db.fail = [{
      table: "points_ledger", op: "select", error: TIMEOUT_ERROR,
      where: (filters) => filters.some(([, c, v]) => c === "reason" && v === "redeem"),
    }];

    await expect(redeemPoints(USER, 500, ORDER)).rejects.toMatchObject({ code: "57014" });
    expect(db.tables.points_ledger.filter((r) => r.reason === "redeem")).toHaveLength(1);
  });

  it("does not re-debit an order that already recorded a redemption", async () => {
    db.tables.points_ledger = [{ order_id: ORDER, user_id: USER, reason: "redeem", amount: -500 }];
    await redeemPoints(USER, 500, ORDER);
    expect(db.tables.points_ledger.filter((r) => r.reason === "redeem")).toHaveLength(1);
  });
});

describe("restoreRedeemedPoints — restore what the LEDGER says was taken", () => {
  it("restores nothing when the debit never landed", async () => {
    // orders.points_redeemed is 500, but the ledger holds no `redeem` row: the
    // debit was skipped or failed. Crediting the order column back would create
    // 500 points out of nothing, on top of a full cash refund — and the refund
    // sweep did exactly that across a 90-day backlog, automatically.
    expect(await restoreRedeemedPoints(ORDER)).toBe(false);
    expect(db.tables.points_ledger).toHaveLength(0);
  });

  it("restores the amount ACTUALLY debited, not what the order intended to spend", async () => {
    // redeemPoints clamps to the live balance: the order wanted 500, only 300
    // could be taken. Giving back 500 hands the customer 200 free points.
    db.tables.points_ledger = [{ order_id: ORDER, user_id: USER, reason: "redeem", amount: -300 }];

    expect(await restoreRedeemedPoints(ORDER)).toBe(true);
    const restored = db.tables.points_ledger.filter((r) => r.reason === "order_refund_points_restore");
    expect(restored).toHaveLength(1);
    expect(restored[0].amount).toBe(300);
  });

  it("restores exactly once", async () => {
    db.tables.points_ledger = [{ order_id: ORDER, user_id: USER, reason: "redeem", amount: -500 }];

    expect(await restoreRedeemedPoints(ORDER)).toBe(true);
    expect(await restoreRedeemedPoints(ORDER)).toBe(false);
    expect(db.tables.points_ledger.filter((r) => r.reason === "order_refund_points_restore")).toHaveLength(1);
  });

  it("REFUSES rather than double-credits when the restore guard read fails", async () => {
    db.tables.points_ledger = [
      { order_id: ORDER, user_id: USER, reason: "redeem", amount: -500 },
      { order_id: ORDER, user_id: USER, reason: "order_refund_points_restore", amount: 500 },
    ];
    db.fail = [{
      table: "points_ledger", op: "select", error: TIMEOUT_ERROR,
      where: (filters) => filters.some(([, c, v]) => c === "reason" && v === "order_refund_points_restore"),
    }];

    await expect(restoreRedeemedPoints(ORDER)).rejects.toMatchObject({ code: "57014" });
    expect(db.tables.points_ledger.filter((r) => r.reason === "order_refund_points_restore")).toHaveLength(1);
  });

  it("is a no-op for a guest order, and stays one", async () => {
    db.tables.orders = [{ order_id: ORDER, customer_user_id: null, points_earned: 0, points_redeemed: 500 }];
    expect(await restoreRedeemedPoints(ORDER)).toBe(false);
    expect(await reverseOrderPoints(ORDER)).toBe(false);
    expect(db.tables.points_ledger).toHaveLength(0);
  });

  it("keeps the balance whole across a redeem-then-refund round trip", async () => {
    db.tables.points_ledger = [{ order_id: "seed", user_id: USER, reason: "order_earn", amount: 1000 }];

    await redeemPoints(USER, 500, ORDER);
    expect(await getPointsBalance(USER)).toBe(500);

    await restoreRedeemedPoints(ORDER);
    expect(await getPointsBalance(USER)).toBe(1000);

    // A second refund event for the same order must not push it past 1000.
    await restoreRedeemedPoints(ORDER);
    expect(await getPointsBalance(USER)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// F-1: THE SAME DEFECT, FOUR LINES FROM WHERE IT WAS FIXED.
//
// ensureCommissionRecord throws when its `ambassadors` read fails
// (payment-webhook.ts). Four lines later it called
// getEffectiveCommissionPercent, which read THE SAME ROW OF THE SAME TABLE and
// discarded the error — so the ambassador's admin-locked rate silently became
// the fallback plus a tier. The commission row was then written, referral_orders
// existed, and the accrual sweep selects on the ABSENCE of that row, so nothing
// ever revisited it: permanently wrong money from one blip, with no alert.
// ---------------------------------------------------------------------------
describe("getEffectiveCommissionPercent — the ambassadors read", () => {
  it("honours an admin-locked rate when the row reads cleanly", async () => {
    const effective = await getEffectiveCommissionPercent({ ambassadorId: AMBASSADOR, fallbackPercent: 8 });
    expect(effective).toEqual({ percent: 25, tierName: null });
  });

  it("REFUSES rather than quietly paying the fallback when the read fails", async () => {
    db.fail = [{ table: "ambassadors", op: "select", error: TIMEOUT_ERROR }];

    await expect(
      getEffectiveCommissionPercent({ ambassadorId: AMBASSADOR, fallbackPercent: 8 }),
    ).rejects.toMatchObject({ code: "57014" });
  });

  it("still treats a genuinely MISSING ambassador as the fallback, not an error", async () => {
    db.tables.ambassadors = [];

    const effective = await getEffectiveCommissionPercent({ ambassadorId: AMBASSADOR, fallbackPercent: 8 });
    // No locked row, one tier at threshold 0, zero qualifying sales -> the tier
    // applies because its threshold is met. The point is that it resolved at
    // all rather than throwing.
    expect(effective.percent).toBe(10);
  });
});
