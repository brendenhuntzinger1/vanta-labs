import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A SHIPPO LABEL MUST ATTACH TO THE ORDER THAT PAID FOR IT, OR TO NOTHING.
//
// applyTransactionCreated writes the tracking number, carrier, label URL and
// the actual postage onto an order, and moves it to label_purchased. If it
// attaches to the WRONG order, the consequences are physical and financial at
// once: order BETA shows ALPHA's tracking, BETA's customer is later emailed
// ALPHA's tracking number, and ALPHA's postage lands in BETA's profit.
//
// WHY THIS FILE EXISTS
//
// Making matchOrder GUESS -- returning an arbitrary order when nothing
// legitimately matched -- left all 2,643 existing tests green. Nothing
// asserted that an unattributable label attaches to no order at all.
//
// These tests drive the real applyTransactionCreated against a mocked
// Supabase, with two fully distinct synthetic orders present, and assert on
// WHICH order was mutated -- not merely that the call returned.
// ---------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  order_number: string;
  shippo_order_id: string | null;
  fulfillment_status: string;
}

const ALPHA: OrderRow = {
  order_id: "11111111-1111-1111-1111-111111111111",
  order_number: "VL-ALPHA01",
  shippo_order_id: "shippo_order_alpha",
  fulfillment_status: "ready_to_fulfill",
};

const BETA: OrderRow = {
  order_id: "22222222-2222-2222-2222-222222222222",
  order_number: "VL-BETA02",
  shippo_order_id: "shippo_order_beta",
  fulfillment_status: "ready_to_fulfill",
};

const state: {
  orders: OrderRow[];
  updatedOrderIds: string[];
  updates: Record<string, unknown>[];
  history: Record<string, unknown>[];
} = { orders: [], updatedOrderIds: [], updates: [], history: [] };

const recordActualShippingCost = vi.fn(async () => {});
vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost }));
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => {
          const filters: Array<[string, string]> = [];
          const builder: Record<string, unknown> = {
            eq(column: string, value: string) {
              filters.push([column, value]);
              return builder;
            },
            limit() {
              return builder;
            },
            async maybeSingle() {
              // Models a real database, deliberately. An UNFILTERED select
              // returns a row -- because Postgres would. Returning null here
              // instead would make this mock hide the exact defect the file
              // exists to catch: a matcher that gives up and grabs whatever
              // order is nearest would look correct against a mock that
              // answers "nothing" to an unfiltered query.
              const found = state.orders.find((order) =>
                filters.every(([column, value]) => String((order as unknown as Record<string, unknown>)[column] ?? "") === value),
              );
              return { data: found ?? null, error: null };
            },
          };
          return builder;
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, value: string) => {
            state.updatedOrderIds.push(value);
            state.updates.push(payload);
            return { error: null };
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
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    };
  };
  return { supabaseAdmin: { from } };
});

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    object_id: "txn_alpha_label",
    status: "SUCCESS",
    tracking_number: "TRKALPHA0001",
    label_url: "https://shippo-delivery.s3.amazonaws.com/alpha.pdf",
    rate: { amount: "7.43", provider: "USPS", servicelevel: { name: "Priority Mail" } },
    ...overrides,
  } as never;
}

async function apply(data: unknown) {
  const { applyTransactionCreated } = await import("@/lib/shippo/order-sync");
  return applyTransactionCreated(data as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.orders = [{ ...ALPHA }, { ...BETA }];
  state.updatedOrderIds = [];
  state.updates = [];
  state.history = [];
});

describe("a purchased label reaches exactly the order it belongs to", () => {
  it("attaches by shippo_order_id to ALPHA, and never touches BETA", async () => {
    const result = await apply(transaction({ order: ALPHA.shippo_order_id }));
    expect(result.matched).toBe(true);
    expect(result.orderId).toBe(ALPHA.order_id);
    expect(state.updatedOrderIds).toEqual([ALPHA.order_id]);
    expect(state.updatedOrderIds).not.toContain(BETA.order_id);
  });

  it("attaches by order_number metadata to BETA, and never touches ALPHA", async () => {
    const result = await apply(transaction({ metadata: BETA.order_number }));
    expect(result.matched).toBe(true);
    expect(result.orderId).toBe(BETA.order_id);
    expect(state.updatedOrderIds).toEqual([BETA.order_id]);
    expect(state.updatedOrderIds).not.toContain(ALPHA.order_id);
  });

  it("attaches by legacy order_id metadata, for labels bought before the switch", async () => {
    const result = await apply(transaction({ metadata: ALPHA.order_id }));
    expect(result.matched).toBe(true);
    expect(result.orderId).toBe(ALPHA.order_id);
  });

  it("prefers shippo_order_id over a metadata value naming a DIFFERENT order", async () => {
    // The id is Shippo's own object; the metadata string is one we echo. If
    // they ever disagree, the id wins and the other order is untouched.
    const result = await apply(
      transaction({ order: ALPHA.shippo_order_id, metadata: BETA.order_number }),
    );
    expect(result.orderId).toBe(ALPHA.order_id);
    expect(state.updatedOrderIds).not.toContain(BETA.order_id);
  });
});

describe("an unattributable label attaches to NOTHING", () => {
  const unattributable: Array<[string, Record<string, unknown>]> = [
    ["no identifiers at all", {}],
    ["an unknown shippo order id", { order: "shippo_order_stranger" }],
    ["an unknown order number", { metadata: "VL-NOTOURS" }],
    ["an unknown order id", { metadata: "99999999-9999-9999-9999-999999999999" }],
    ["empty identifiers", { order: "", metadata: "" }],
    ["whitespace identifiers", { order: "   ", metadata: "   " }],
  ];

  for (const [label, overrides] of unattributable) {
    it(`refuses to guess for ${label}`, async () => {
      const result = await apply(transaction(overrides));
      expect(result.matched).toBe(false);
      expect(result.orderId).toBeNull();
      expect(result.reason).toBe("no_matching_order");
      // THE POINT OF THIS FILE: no order was mutated, and no postage recorded.
      expect(state.updatedOrderIds).toEqual([]);
      expect(state.history).toEqual([]);
      expect(recordActualShippingCost).not.toHaveBeenCalled();
    });
  }

  it("never matches on customer identity, however tempting", async () => {
    // No customer name, email or address may resolve a transaction. Two people
    // share a name; nobody shares an order id.
    const result = await apply(
      transaction({ customer_email: "someone@example.test", customer_name: "A Customer" }),
    );
    expect(result.matched).toBe(false);
    expect(state.updatedOrderIds).toEqual([]);
  });
});

describe("a transaction that did not actually succeed", () => {
  for (const status of ["ERROR", "QUEUED", "WAITING", ""]) {
    it(`ignores a ${status || "(empty)"} transaction entirely`, async () => {
      const result = await apply(transaction({ order: ALPHA.shippo_order_id, status }));
      expect(result.matched).toBe(false);
      expect(result.reason).toBe("transaction_not_successful");
      // A label that was never really bought must not write postage or tracking.
      expect(state.updatedOrderIds).toEqual([]);
      expect(recordActualShippingCost).not.toHaveBeenCalled();
    });
  }
});

describe("what a matched label writes", () => {
  it("records the exact postage in cents against the matched order only", async () => {
    await apply(transaction({ order: ALPHA.shippo_order_id }));
    expect(state.updates[0]?.postage_cost_cents).toBe(743);
    expect(recordActualShippingCost).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ALPHA.order_id, amountCents: 743, source: "shippo" }),
    );
  });

  it("records ALPHA's tracking number on ALPHA, so BETA's customer cannot receive it", async () => {
    await apply(transaction({ order: ALPHA.shippo_order_id }));
    expect(state.updates[0]?.tracking_number).toBe("TRKALPHA0001");
    expect(state.updatedOrderIds).toEqual([ALPHA.order_id]);
  });

  it("moves the order to label_purchased and NOT to shipped", async () => {
    await apply(transaction({ order: ALPHA.shippo_order_id }));
    expect(state.updates[0]?.fulfillment_status).toBe("label_purchased");
    expect(state.updates[0]?.fulfillment_status).not.toBe("shipped");
    expect(state.updates[0]).not.toHaveProperty("shipped_at");
  });

  it("leaves postage NULL rather than 0 when Shippo gives no readable amount", async () => {
    await apply(transaction({ order: ALPHA.shippo_order_id, rate: { provider: "USPS" } }));
    // Writing 0 would silently overstate the margin.
    expect(state.updates[0]).not.toHaveProperty("postage_cost_cents");
    expect(recordActualShippingCost).not.toHaveBeenCalled();
  });
});
