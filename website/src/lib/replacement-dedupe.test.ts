import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE APOLOGY, ONE PARCEL.
//
// A replacement is a free reshipment. Creating it twice means two parcels, two
// labels, two lots of postage the store pays, and stock deducted twice -- for
// one damaged order. Nothing charges the customer, so nothing else in the
// system pushes back on the duplicate.
//
// The guard is a DERIVED order id: sha256(originalOrderId :: requestId). The
// request id is minted once when the confirmation dialog opens, so a
// double-click, a retried fetch and a second tab all carry the SAME id and
// collide on the orders primary key. Two genuine replacements mean two
// dialogs, two request ids, two orders.
//
// WHY THIS FILE EXISTS
//
// Removing the derivation (back to a random uuid per call) and removing the
// duplicate pre-check EACH left all 2,684 existing tests green. Nothing proved
// that a double-click produces one replacement.
// ---------------------------------------------------------------------------

const ORIGINAL_ID = "order-original-0001";

const state: {
  insertedOrderIds: string[];
  existingOrderIds: Set<string>;
  inventoryCalls: number;
} = { insertedOrderIds: [], existingOrderIds: new Set(), inventoryCalls: 0 };

const decrementInventoryForOrder = vi.fn(async () => {
  state.inventoryCalls += 1;
  return { attempted: 1, failed: 0, errors: [] as string[] };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/inventory-fulfillment", () => ({ decrementInventoryForOrder }));
const alerts: Array<{ type: string; message: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: { type: string; message: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  }),
}));
vi.mock("@/lib/ledger", () => ({ PAID_ORDER_STATUSES: new Set(["paid"]) }));

const ORIGINAL_ROW = {
  order_id: ORIGINAL_ID,
  order_number: "VL-ORIG0001",
  payment_status: "paid",
  customer_email: "buyer@example.test",
  customer_name: "A Buyer",
  shipping_address: "1 Test Street",
  city: "Testville",
  postal_code: "00000",
  country: "US",
  currency: "USD",
  ambassador_id: "amb-1",
  customer_user_id: "user-1",
  order_items: [
    { id: 1, product_id: "prod-1", product_name: "BPC-157 10mg", quantity: 2, unit_cost_cents: 1000 },
  ],
};

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => {
          let requested = "";
          const builder: Record<string, unknown> = {
            eq(_column: string, value: string) {
              requested = value;
              return builder;
            },
            async maybeSingle() {
              if (requested === ORIGINAL_ID) return { data: { ...ORIGINAL_ROW }, error: null };
              if (state.existingOrderIds.has(requested)) {
                return {
                  data: {
                    order_id: requested,
                    order_number: "VL-REPL001",
                    customer_email: ORIGINAL_ROW.customer_email,
                    customer_name: ORIGINAL_ROW.customer_name,
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };
          return builder;
        },
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.order_id);
          if (state.existingOrderIds.has(id)) {
            // The real guarantee: the primary key refuses the second write.
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          state.existingOrderIds.add(id);
          state.insertedOrderIds.push(id);
          return { error: null };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    return {
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  };
  return { supabaseAdmin: { from } };
});

async function create(requestId: string | null | undefined) {
  const { createReplacementOrder } = await import("@/lib/admin-replacements");
  return createReplacementOrder({
    originalOrderId: ORIGINAL_ID,
    reason: "damaged",
    requestId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.insertedOrderIds = [];
  state.existingOrderIds = new Set();
  state.inventoryCalls = 0;
  alerts.length = 0;
  decrementInventoryForOrder.mockImplementation(async () => {
    state.inventoryCalls += 1;
    return { attempted: 1, failed: 0, errors: [] as string[] };
  });
});

describe("a double-click cannot ship two free parcels", () => {
  it("creates one replacement for one request id", async () => {
    const result = await create("req-aaa");
    expect(result.duplicate).toBeFalsy();
    expect(state.insertedOrderIds).toHaveLength(1);
  });

  it("returns the SAME replacement for a repeated request id, and inserts once", async () => {
    const first = await create("req-aaa");
    const second = await create("req-aaa");

    expect(second.orderId).toBe(first.orderId);
    expect(second.duplicate).toBe(true);
    // The point: one parcel, one label, one lot of postage.
    expect(state.insertedOrderIds).toHaveLength(1);
  });

  it("does not deduct stock twice for one apology", async () => {
    await create("req-aaa");
    const callsAfterFirst = state.inventoryCalls;
    await create("req-aaa");
    expect(state.inventoryCalls).toBe(callsAfterFirst);
  });

  it("ships ONE parcel when three clicks race past the pre-check", async () => {
    // Truly simultaneous calls all miss the pre-check (nothing is written
    // yet), so all three attempt the insert. The primary key -- not the
    // pre-check -- is what makes this safe: the losers are refused by the
    // database and raise, rather than creating a second free shipment.
    //
    // The business invariant is ONE PARCEL, not "every caller gets a tidy
    // result". A racing operator seeing an error is the acceptable outcome;
    // a second parcel is not.
    const results = await Promise.allSettled([create("req-aaa"), create("req-aaa"), create("req-aaa")]);

    expect(state.insertedOrderIds).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    for (const rejected of results.filter((r) => r.status === "rejected")) {
      // And it fails for the RIGHT reason -- a key collision, not some
      // unrelated error that would also produce one insert by accident.
      expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/duplicate key/i);
    }
  });

  it("derives the order id from the request id, so the id itself is the guard", async () => {
    const a = await create("req-aaa");
    state.existingOrderIds = new Set();
    state.insertedOrderIds = [];
    const again = await create("req-aaa");
    // Same inputs must always produce the same id -- otherwise the primary key
    // can never collide and the guard does not exist.
    expect(again.orderId).toBe(a.orderId);
  });

  it("still allows a SECOND genuine replacement from a new dialog", async () => {
    const first = await create("req-aaa");
    const second = await create("req-bbb");
    expect(second.orderId).not.toBe(first.orderId);
    expect(second.duplicate).toBeFalsy();
    expect(state.insertedOrderIds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F-3 — A FIFTH DEAD ALERT SITE OF THE SAME CLASS.
//
// decrementInventoryForOrder is best-effort per line and NEVER throws, so the
// try/catch this alert lived in was unreachable code. Both payment-webhook
// lanes were converted to read the returned outcome; this third caller was
// missed. Real stock leaves the warehouse for a replacement, every line fails,
// and nothing at all is recorded.
// ---------------------------------------------------------------------------
describe("a replacement whose stock decrement did not move anything", () => {
  it("raises the critical alert the try/catch could never reach", async () => {
    decrementInventoryForOrder.mockResolvedValueOnce({
      attempted: 2,
      failed: 2,
      errors: ["p1: adjust_inventory_on_sale unavailable", "p2: adjust_inventory_on_sale unavailable"],
    });

    await create("dead-alert-1");

    const alert = alerts.find((entry) => entry.type === "replacement_inventory_not_decremented");
    expect(alert).toBeDefined();
    expect(alert!.message).toContain("2 of 2");
    expect(alert!.context).toMatchObject({ attempted: 2, failed: 2 });
  });

  it("reports a PARTIAL failure too, with the true counts", async () => {
    decrementInventoryForOrder.mockResolvedValueOnce({
      attempted: 3,
      failed: 1,
      errors: ["p3: adjust_inventory_on_sale unavailable"],
    });

    await create("dead-alert-2");

    const alert = alerts.find((entry) => entry.type === "replacement_inventory_not_decremented");
    expect(alert!.message).toContain("1 of 3");
  });

  it("says nothing when every line moved", async () => {
    await create("dead-alert-3");

    expect(alerts.find((entry) => entry.type === "replacement_inventory_not_decremented")).toBeUndefined();
  });
});
