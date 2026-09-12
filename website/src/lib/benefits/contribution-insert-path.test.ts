import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// M5b — WHEN THE SNAPSHOT IS WRITTEN, AND WHEN IT IS NOT.
//
// contribution-store.test.ts proves the writer sends the right row.
// order-contribution-sql.test.ts proves the database enforces one row per
// order. Neither answers the question in between: does `insertOrderRow` call
// the writer on exactly the orders it should?
//
// Four cases, and only the first may produce a snapshot:
//
//   the order inserted          → exactly one snapshot
//   the order was a DUPLICATE   → none (the retry must not write a second)
//   the order insert FAILED     → none (there is no order to describe)
//   the snapshot write failed   → the order is still reported as inserted
// ---------------------------------------------------------------------------

type InsertResult = { error: { code?: string; message?: string } | null };

const state = vi.hoisted(() => ({
  orderInsert: { error: null } as InsertResult,
  snapshotCalls: [] as Array<{ orderId: string; contribution: unknown; attribution: unknown }>,
  snapshotThrows: false,
  alerts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {
      insert: async () => (table === "orders" ? state.orderInsert : { error: null }),
      upsert: async () => ({ error: null }),
    };
    for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) {
      self[method] = () => self;
    }
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.then = (onResolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
    return self;
  };
  const client = { from: (table: string) => chain(table), rpc: async () => ({ data: null, error: null }) };
  return { supabaseAdmin: client, createServerClient: () => client };
});

vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: Record<string, unknown>) => { state.alerts.push(alert); },
}));

vi.mock("@/lib/benefits/contribution-store", () => ({
  recordContributionSnapshot: async (orderId: string, contribution: unknown, attribution: unknown) => {
    state.snapshotCalls.push({ orderId, contribution, attribution });
    // The real writer never throws. This one does on demand, to prove that even
    // if that guarantee were ever broken the sale would still stand.
    if (state.snapshotThrows) throw new Error("snapshot exploded");
  },
}));

const CONTRIBUTION = {
  formulaVersion: 1, basis: "quote" as const,
  paidMerchandiseCents: 13998, shippingCollectedCents: 1500, handlingCollectedCents: 0,
  revenueCents: 15498, productCostCents: 2636, giftCogsCents: 0, processingFeeCents: 1240,
  shippingCostCents: 600, storeCreditRedeemedCents: 0, pointsRedeemedValueCents: 0,
  pointsEarnedValueCents: 0, deductionsCents: 4476,
  contributionBeforeCommissionCents: 11022, bindingConstraint: "productCost" as const,
  discountAmountCents: 0, costIsEstimated: false,
};

const draft = () => ({
  full: { order_id: "ord-77", order_number: "VL-77" },
  base: { order_id: "ord-77" },
  profitFloor: {
    subtotal: 139.98, discountAmount: 0, discountLabel: "None", commission: 0,
    processingFee: 12.4, productCost: 26.36, shippingCollected: 15, shippingCost: 6,
    estimatedProfit: 110.22, thresholdDollars: 0, thresholdPercent: 0, belowFloor: false,
    contribution: CONTRIBUTION,
  },
  contributionAttribution: { offerKey: "sms_welcome_bac_water" },
});

beforeEach(() => {
  state.orderInsert = { error: null };
  state.snapshotCalls = [];
  state.snapshotThrows = false;
  state.alerts = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("insertOrderRow writes exactly one snapshot for an order it inserted", () => {
  it("calls the writer once, with the order id, breakdown and attribution", async () => {
    const { insertOrderRow } = await import("@/lib/quote-order");
    const outcome = await insertOrderRow(draft());

    expect(outcome.status).toBe("inserted");
    expect(state.snapshotCalls).toHaveLength(1);
    expect(state.snapshotCalls[0].orderId).toBe("ord-77");
    expect(state.snapshotCalls[0].contribution).toBe(CONTRIBUTION);
    expect(state.snapshotCalls[0].attribution).toEqual({ offerKey: "sms_welcome_bac_water" });
  });

  it("passes the breakdown straight off the floor snapshot, not a rebuilt one", async () => {
    // Same object identity: the number persisted is the number the quote
    // computed, never a second derivation at insert time.
    const { insertOrderRow } = await import("@/lib/quote-order");
    const d = draft();
    await insertOrderRow(d);
    expect(state.snapshotCalls[0].contribution).toBe(d.profitFloor.contribution);
  });
});

describe("a retry cannot produce a second snapshot", () => {
  it("writes nothing when the order was a duplicate", async () => {
    // Postgres 23505 — the idempotency key caught a re-submitted checkout.
    state.orderInsert = { error: { code: "23505", message: "duplicate key" } };
    const { insertOrderRow } = await import("@/lib/quote-order");
    const outcome = await insertOrderRow(draft());

    expect(outcome.status).toBe("duplicate");
    expect(state.snapshotCalls).toHaveLength(0);
  });
});

describe("no order, no snapshot", () => {
  it("writes nothing when the order insert failed outright", async () => {
    state.orderInsert = { error: { code: "42501", message: "permission denied" } };
    const { insertOrderRow } = await import("@/lib/quote-order");
    const outcome = await insertOrderRow(draft());

    expect(outcome.status).toBe("error");
    expect(state.snapshotCalls).toHaveLength(0);
  });
});

describe("the sale stands even if the snapshot does not", () => {
  it("still reports the order as inserted when the writer throws", async () => {
    // The real writer swallows everything (contribution-store.test.ts proves
    // it). This asserts the SECOND line of defence: even a writer that breaks
    // its own contract cannot turn a completed order into a failed one.
    state.snapshotThrows = true;
    const { insertOrderRow } = await import("@/lib/quote-order");

    await expect(insertOrderRow(draft())).resolves.toEqual({ status: "inserted" });
  });
});

describe("an order with no contribution on its floor snapshot", () => {
  it("still inserts, and hands the writer the absence rather than inventing one", async () => {
    const d = draft();
    // A lane that priced through an older quote, or a snapshot built before M5.
    (d.profitFloor as Record<string, unknown>).contribution = undefined;
    const { insertOrderRow } = await import("@/lib/quote-order");
    const outcome = await insertOrderRow(d);

    expect(outcome.status).toBe("inserted");
    expect(state.snapshotCalls).toHaveLength(1);
    expect(state.snapshotCalls[0].contribution).toBeUndefined();
  });

  it("inserts when there is no floor snapshot at all", async () => {
    const d = draft();
    (d as { profitFloor: unknown }).profitFloor = null;
    const { insertOrderRow } = await import("@/lib/quote-order");
    const outcome = await insertOrderRow(d);

    expect(outcome.status).toBe("inserted");
    expect(state.snapshotCalls[0].contribution).toBeUndefined();
  });
});
