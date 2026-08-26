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
});

// ---------------------------------------------------------------------------
// THE POINT OF THIS SECTION: proof a retry cannot duplicate a financial write.
//
// planRefundRepairs proves the selector — that it correctly picks out which
// effects are missing. It does NOT prove the sweep is safe to re-run, because
// nothing in that suite ever calls repairIncompleteRefunds twice. A cron that
// fires this sweep on a schedule WILL see the same refunded order again on
// the next tick if the current run's fix hasn't landed for any reason (a slow
// deploy, an overlapping run). This test runs repairIncompleteRefunds() TWICE
// over the SAME order and asserts the second run is a genuine no-op: no
// second call to reverseOrderPoints, restoreRedeemedPoints, or
// refundStoreCreditForOrder, and no second orders update — because the first
// run's writes actually landed in the mock state the second run reads.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const order = {
    order_id: "order-1",
    payment_status: "refunded",
    refund_amount: 0,
    points_earned: 120,
    points_redeemed: 50,
    store_credit_redeemed_cents: 500,
    amount_paid: 4999,
    refunded_at: "2026-08-20T00:00:00Z",
  };

  // Ledger rows that the mocked effect functions insert when they run "for
  // real" — this is what makes the second run's absence check genuinely see
  // a repaired order, rather than a mock that was simply told to no-op.
  const pointsLedgerRows: Array<{ order_id: string; reason: string }> = [];
  const storeCreditLedgerRows: Array<{ order_id: string; reason: string }> = [];

  const reverseOrderPoints = vi.fn(async (orderId: string) => {
    if (pointsLedgerRows.some((r) => r.order_id === orderId && r.reason === "order_refund_reversal")) {
      return; // mirrors the real function's own existing-row guard
    }
    pointsLedgerRows.push({ order_id: orderId, reason: "order_refund_reversal" });
  });

  const restoreRedeemedPoints = vi.fn(async (orderId: string) => {
    if (pointsLedgerRows.some((r) => r.order_id === orderId && r.reason === "order_refund_points_restore")) {
      return;
    }
    pointsLedgerRows.push({ order_id: orderId, reason: "order_refund_points_restore" });
  });

  const refundStoreCreditForOrder = vi.fn(async (orderId: string) => {
    if (storeCreditLedgerRows.some((r) => r.order_id === orderId && r.reason === "membership_redemption_refund")) {
      return;
    }
    storeCreditLedgerRows.push({ order_id: orderId, reason: "membership_redemption_refund" });
  });

  const recordSystemAlert = vi.fn(async () => {});

  let ordersUpdateCalls = 0;

  return {
    order,
    pointsLedgerRows,
    storeCreditLedgerRows,
    reverseOrderPoints,
    restoreRedeemedPoints,
    refundStoreCreditForOrder,
    recordSystemAlert,
    get ordersUpdateCalls() {
      return ordersUpdateCalls;
    },
    bumpOrdersUpdateCalls() {
      ordersUpdateCalls += 1;
    },
    resetOrdersUpdateCalls() {
      ordersUpdateCalls = 0;
    },
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/membership", () => ({
  reverseOrderPoints: mocks.reverseOrderPoints,
  restoreRedeemedPoints: mocks.restoreRedeemedPoints,
}));

vi.mock("@/lib/store-credit", () => ({
  refundStoreCreditForOrder: mocks.refundStoreCreditForOrder,
}));

vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: mocks.recordSystemAlert,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "orders") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          gte: () => builder,
          order: () => builder,
          limit: async () => ({ data: [{ ...mocks.order }], error: null }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_col1: string, _val1: unknown) => ({
              eq: (_col2: string, refundAmountFilter: unknown) => {
                // Emulate the real `.eq("refund_amount", 0)` guard: only apply
                // the write when the mock row's current refund_amount is 0.
                if (mocks.order.refund_amount === refundAmountFilter) {
                  mocks.order.refund_amount = Number(patch.refund_amount ?? 0);
                  mocks.bumpOrdersUpdateCalls();
                }
                return Promise.resolve({ error: null });
              },
            }),
          }),
        };
        return builder;
      }
      if (table === "points_ledger") {
        return {
          select: () => ({
            in: async () => ({ data: mocks.pointsLedgerRows.map((r) => ({ ...r })), error: null }),
          }),
        };
      }
      if (table === "store_credit_ledger") {
        return {
          select: () => ({
            in: async () => ({ data: mocks.storeCreditLedgerRows.map((r) => ({ ...r })), error: null }),
          }),
        };
      }
      throw new Error(`unexpected table in test: ${table}`);
    },
  },
}));

// Import after the mocks above (vi.mock calls are hoisted, so this is safe).
// Using a separate import block keeps the pure-predicate suite above free of
// any module mocking.
import { repairIncompleteRefunds } from "@/lib/refund-effect-repair";

describe("repairIncompleteRefunds — running twice over the same order", () => {
  beforeEach(() => {
    mocks.order.refund_amount = 0;
    mocks.pointsLedgerRows.length = 0;
    mocks.storeCreditLedgerRows.length = 0;
    mocks.reverseOrderPoints.mockClear();
    mocks.restoreRedeemedPoints.mockClear();
    mocks.refundStoreCreditForOrder.mockClear();
    mocks.resetOrdersUpdateCalls();
  });

  it("repairs all four effects on the first run, then performs no further writes on the second", async () => {
    const first = await repairIncompleteRefunds();
    expect(first).toEqual({ scanned: 1, repaired: 4, failed: 0 });
    expect(mocks.reverseOrderPoints).toHaveBeenCalledTimes(1);
    expect(mocks.restoreRedeemedPoints).toHaveBeenCalledTimes(1);
    expect(mocks.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
    expect(mocks.ordersUpdateCalls).toBe(1);

    // The mock writes actually landed on the state the second run will read —
    // this is what makes the second run's absence check genuinely see a
    // repaired order rather than an untouched mock.
    expect(mocks.order.refund_amount).toBe(4999);
    expect(mocks.pointsLedgerRows).toEqual([
      { order_id: "order-1", reason: "order_refund_reversal" },
      { order_id: "order-1", reason: "order_refund_points_restore" },
    ]);
    expect(mocks.storeCreditLedgerRows).toEqual([
      { order_id: "order-1", reason: "membership_redemption_refund" },
    ]);

    const second = await repairIncompleteRefunds();
    expect(second).toEqual({ scanned: 1, repaired: 0, failed: 0 });

    // Still 1 each — the second run made no new call to any effect, and no
    // second orders update.
    expect(mocks.reverseOrderPoints).toHaveBeenCalledTimes(1);
    expect(mocks.restoreRedeemedPoints).toHaveBeenCalledTimes(1);
    expect(mocks.refundStoreCreditForOrder).toHaveBeenCalledTimes(1);
    expect(mocks.ordersUpdateCalls).toBe(1);
  });
});
