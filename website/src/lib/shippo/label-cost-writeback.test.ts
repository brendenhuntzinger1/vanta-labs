import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A PURCHASED LABEL MUST RECORD WHAT IT COST.
//
// Found on a real $18.95 production order. The owner bought the label in
// Shippo's dashboard, the `transaction_created` webhook arrived, matched the
// order and moved it to `label_purchased` — and wrote no cost, no carrier and
// no tracking. The admin showed:
//
//     Actual shipping: Pending label purchase
//     Net profit: $8.57 — ESTIMATED
//
// for a shipment that had already been paid for. Three of three labelled orders
// were in that state, so this was an accounting-wide defect, not one bad row.
//
// The cause was a single read. Shippo sends `rate` expanded on some responses
// and as a bare object_id STRING on others; the webhook type declared only the
// object, so `data.rate?.amount` compiled cleanly and evaluated to undefined
// against the string form. The status move in the same UPDATE succeeded, which
// is why the failure looked like "label bought" rather than "label unrecorded".
//
// These drive the real applyTransactionCreated against a mocked Supabase and a
// mocked Shippo client, so they exercise the actual read rather than restate it.
// ---------------------------------------------------------------------------

const state: {
  order: Record<string, unknown> | null;
  updates: Record<string, unknown>[];
  costCalls: { orderId: string; amountCents: number; source: string }[];
} = { order: null, updates: [], costCalls: [] };

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.order }) }) }),
        update: (payload: Record<string, unknown>) => {
          state.updates.push(payload);
          if (state.order) Object.assign(state.order, payload);
          return { eq: async () => ({ error: null }) };
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

vi.mock("@/lib/admin-profit", () => ({
  recordActualShippingCost: vi.fn(async (input: { orderId: string; amountCents: number; source: string }) => {
    state.costCalls.push(input);
    return { ok: true };
  }),
}));

// The authoritative record of what was actually spent. Controlled per test so
// the "webhook was thin" path can be driven deliberately.
const transactionResponse: { value: unknown } = { value: null };
vi.mock("@/lib/shippo/client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTransaction: vi.fn(async () =>
      transactionResponse.value
        ? { ok: true, data: transactionResponse.value }
        : { ok: false, kind: "unavailable", message: "Shippo unreachable", safeToRetry: true },
    ),
    createShipmentWithRates: vi.fn(async () => ({ ok: false, kind: "rejected", message: "n/a", safeToRetry: false })),
    createShippoOrder: vi.fn(async () => ({ ok: false, kind: "rejected", message: "n/a", safeToRetry: false })),
  };
});

const { applyTransactionCreated, labelFactsFrom } = await import("@/lib/shippo/order-sync");

function seed(overrides: Record<string, unknown> = {}) {
  state.order = {
    order_id: "ord-cost-1",
    order_number: "VL-COST1",
    fulfillment_status: "ready_to_fulfill",
    payment_status: "paid",
    shippo_order_id: "shippo-order-1",
    tracking_number: null,
    shipping_carrier: null,
    shipping_service: null,
    label_url: null,
    shippo_transaction_id: null,
    postage_cost_cents: null,
    ...overrides,
  };
  state.updates = [];
  state.costCalls = [];
  transactionResponse.value = null;
}

/** The label really cost $8.45. That number must survive to the order. */
const EXPANDED_RATE = { amount: "8.45", provider: "USPS", servicelevel: { name: "Ground Advantage" } };

const withExpandedRate = {
  status: "SUCCESS",
  object_id: "shippo-txn-1",
  order: "shippo-order-1",
  tracking_number: "9400100000000000000000",
  label_url: "https://example.invalid/label.pdf",
  rate: EXPANDED_RATE,
};

/** Exactly what production sent: a rate that is only an id. */
const withStringRate = {
  status: "SUCCESS",
  object_id: "shippo-txn-1",
  order: "shippo-order-1",
  rate: "3a7fa84885e7401487990c2b43ddc105",
};

describe("labelFactsFrom reads both shapes Shippo sends", () => {
  it("reads an expanded rate", () => {
    expect(labelFactsFrom(withExpandedRate)).toMatchObject({
      amountCents: 845,
      carrier: "USPS",
      service: "Ground Advantage",
    });
  });

  it("does not invent a cost from a rate that is only an id", () => {
    // A string rate carries no price. The old code read `.amount` off it and
    // got undefined; the requirement is that this is recognised, not guessed.
    expect(labelFactsFrom(withStringRate)).toMatchObject({
      amountCents: null,
      carrier: null,
      service: null,
    });
  });
});

describe("a label bought in Shippo's dashboard", () => {
  beforeEach(() => seed());

  it("records the cost when the webhook carries an expanded rate", async () => {
    await applyTransactionCreated(withExpandedRate as never);
    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.postage_cost_cents).toBe(845);
    expect(state.costCalls).toHaveLength(1);
    expect(state.costCalls[0]).toMatchObject({ amountCents: 845, source: "shippo" });
  });

  it("THE REAL FAILURE: recovers the cost when the webhook only sends a rate id", async () => {
    // Shippo's authoritative record of the same transaction.
    transactionResponse.value = {
      object_id: "shippo-txn-1",
      status: "SUCCESS",
      tracking_number: "9400100000000000000000",
      label_url: "https://example.invalid/label.pdf",
      rate: EXPANDED_RATE,
    };

    await applyTransactionCreated(withStringRate as never);

    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.postage_cost_cents).toBe(845);
    expect(written.shipping_carrier).toBe("USPS");
    expect(written.tracking_number).toBe("9400100000000000000000");
    expect(state.costCalls).toHaveLength(1);
    expect(state.costCalls[0]).toMatchObject({ amountCents: 845 });
  });

  it("still moves the order to label_purchased", async () => {
    transactionResponse.value = { object_id: "shippo-txn-1", status: "SUCCESS", rate: EXPANDED_RATE };
    await applyTransactionCreated(withStringRate as never);
    expect(state.order?.fulfillment_status).toBe("label_purchased");
  });

  it("leaves the cost unset — never zero — when Shippo cannot be reached", async () => {
    // Writing 0 would read as a free label and silently overstate the margin.
    // NULL is what makes the admin say "Pending" and ask the owner.
    transactionResponse.value = null;
    await applyTransactionCreated(withStringRate as never);
    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.postage_cost_cents).toBeUndefined();
    expect(state.costCalls).toHaveLength(0);
    expect(state.order?.fulfillment_status).toBe("label_purchased");
  });
});

describe("repeat deliveries of the same label", () => {
  it("record the same cost, never an accumulating one", async () => {
    seed();
    await applyTransactionCreated(withExpandedRate as never);
    await applyTransactionCreated(withExpandedRate as never);
    // Each call reports the same absolute figure; nothing adds to a running
    // total, so a duplicate cannot double-charge the margin.
    expect(state.costCalls.every((c) => c.amountCents === 845)).toBe(true);
    expect(state.order?.postage_cost_cents).toBe(845);
  });

  it("a thinner replay does not erase a tracking number we already hold", async () => {
    seed({ tracking_number: "9400100000000000000000", shipping_carrier: "USPS" });
    transactionResponse.value = null; // Shippo unreachable on the replay
    await applyTransactionCreated(withStringRate as never);
    expect(state.order?.tracking_number).toBe("9400100000000000000000");
    expect(state.order?.shipping_carrier).toBe("USPS");
  });
});
