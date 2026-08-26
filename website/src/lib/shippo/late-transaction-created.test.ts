import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A LATE `transaction_created` MUST NOT WALK AN ORDER BACKWARDS.
//
// applyTransactionCreated() writes fulfillment_status = "label_purchased"
// directly. Shippo is a legitimate source for that status, so the SOURCE rule
// was never the problem — the missing piece was the MONOTONIC one. Shippo
// replays and reorders deliveries, so a `transaction_created` arriving after
// the parcel has already been scanned in transit (or delivered) would have
// rewritten a later state with an earlier one.
//
// canTransition() already implements exactly this rule for source "shippo":
// it rejects a move whose progressRank is lower than the current one, and
// rejects any move out of a terminal status. The fix routes the write through
// it rather than inventing a second monotonicity check.
//
// These tests drive the real function against a mocked Supabase, so they
// exercise the actual guard rather than a restatement of it.
// ---------------------------------------------------------------------------

const state: {
  order: Record<string, unknown> | null;
  updates: Record<string, unknown>[];
  history: Record<string, unknown>[];
} = { order: null, updates: [], history: [] };

vi.mock("@/lib/supabase-server", async () => {
  // Postgres-faithful update semantics: see the double's own header.
  const { ordersUpdateDouble } = await import("./test-support/orders-table-double");
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.order }),
          }),
        }),
        update: ordersUpdateDouble({
          currentStatus: () => (state.order?.fulfillment_status as string | null) ?? null,
          onCommit: (payload) => {
            state.updates.push(payload);
            if (state.order) Object.assign(state.order, payload);
          },
        }),
      };
    }
    if (table === "order_status_history") {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.history.push(row);
          return { error: null };
        },
      };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
      insert: async () => ({ error: null }),
    };
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/shipping-costs", () => ({
  recordActualShippingCost: vi.fn(async () => ({ ok: true })),
}));

const { applyTransactionCreated } = await import("@/lib/shippo/order-sync");

function seed(fulfillmentStatus: string) {
  state.order = {
    order_id: "ord-late-1",
    order_number: "VL-LATE1",
    fulfillment_status: fulfillmentStatus,
    payment_status: "paid",
    shippo_order_id: "shippo-order-1",
    tracking_number: null,
    shipping_carrier: null,
    shipping_service: null,
    label_url: null,
    shippo_transaction_id: null,
    postage_cost_cents: null,
  };
  state.updates = [];
  state.history = [];
}

const EVENT = {
  status: "SUCCESS",
  object_id: "shippo-txn-1",
  order: "shippo-order-1",
  tracking_number: "9400100000000000000000",
  label_url: "https://shippo-delivery.s3.amazonaws.com/label.pdf",
  rate: { amount: "8.45", provider: "USPS", servicelevel: { name: "Ground Advantage" } },
};

describe("transaction_created on an order that has not shipped yet", () => {
  beforeEach(() => seed("ready_to_fulfill"));

  it("moves the order to label_purchased", async () => {
    const result = await applyTransactionCreated(EVENT as never);
    expect(result.matched).toBe(true);
    expect(state.order?.fulfillment_status).toBe("label_purchased");
  });

  it("records the label metadata Shippo reported", async () => {
    await applyTransactionCreated(EVENT as never);
    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.tracking_number).toBe("9400100000000000000000");
    expect(written.shipping_carrier).toBe("USPS");
    expect(written.shipping_service).toBe("Ground Advantage");
    expect(written.shippo_transaction_id).toBe("shippo-txn-1");
    expect(written.label_url).toContain("label.pdf");
    expect(written.postage_cost_cents).toBe(845);
    expect(written.label_purchased_at).toBeTruthy();
  });

  it("writes one history row attributed to Shippo", async () => {
    await applyTransactionCreated(EVENT as never);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.to_status).toBe("label_purchased");
    expect(state.history[0]?.source).toBe("shippo");
  });
});

describe("a LATE transaction_created must not regress the order", () => {
  // Each of these is further along than label_purchased. progressRank rejects a
  // backwards move for source "shippo"; delivered is additionally terminal.
  const LATER_STATES = ["in_transit", "out_for_delivery", "delivered"];

  it.each(LATER_STATES)("%s stays put", async (current) => {
    seed(current);
    await applyTransactionCreated(EVENT as never);
    expect(
      state.order?.fulfillment_status,
      `a late transaction_created rewrote ${current} — the parcel's progress was lost`,
    ).toBe(current);
  });

  it.each(LATER_STATES)("%s gets no fake label_purchased history", async (current) => {
    seed(current);
    await applyTransactionCreated(EVENT as never);
    const regressions = state.history.filter((h) => h.to_status === "label_purchased");
    expect(regressions).toHaveLength(0);
  });

  it("still records the label metadata, which is not a status claim", async () => {
    // The tracking number and postage are FACTS about the shipment and remain
    // true whenever they arrive. Only the STATUS must not move backwards —
    // dropping the metadata would lose the real cost of a real label.
    seed("in_transit");
    await applyTransactionCreated(EVENT as never);
    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.shippo_transaction_id).toBe("shippo-txn-1");
    expect(written.postage_cost_cents).toBe(845);
    expect(written.fulfillment_status).toBeUndefined();
  });
});

describe("duplicate delivery of the same event", () => {
  it("does not write a second history row", async () => {
    seed("ready_to_fulfill");
    await applyTransactionCreated(EVENT as never);
    const afterFirst = state.history.length;
    // The order is now label_purchased, so the identical event is an
    // "unchanged" transition — no new history, no second claim of progress.
    await applyTransactionCreated(EVENT as never);
    expect(state.history.length).toBe(afterFirst);
    expect(state.order?.fulfillment_status).toBe("label_purchased");
  });
});

describe("events that are not a successful purchase", () => {
  it("ignores a non-SUCCESS transaction", async () => {
    seed("ready_to_fulfill");
    const result = await applyTransactionCreated({ ...EVENT, status: "ERROR" } as never);
    expect(result.matched).toBe(false);
    expect(state.order?.fulfillment_status).toBe("ready_to_fulfill");
    expect(state.updates).toHaveLength(0);
  });
});
