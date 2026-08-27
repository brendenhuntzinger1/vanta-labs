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

vi.mock("@/lib/supabase-server", async () => {
  // Postgres-faithful update semantics: see the double's own header.
  const { ordersUpdateDouble } = await import("./test-support/orders-table-double");
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.order }) }) }),
        update: ordersUpdateDouble({
          currentStatus: () => (state.order?.fulfillment_status as string | null) ?? null,
          onCommit: (payload) => {
            state.updates.push(payload);
            if (state.order) Object.assign(state.order, payload);
          },
        }),
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

// Set by a test that needs the money write to REFUSE, which it reports as a
// return value rather than a throw.
const costOutcome: { value: { ok: boolean; error?: string } } = { value: { ok: true } };
vi.mock("@/lib/admin-profit", () => ({
  recordActualShippingCost: vi.fn(async (input: { orderId: string; amountCents: number; source: string }) => {
    state.costCalls.push(input);
    return costOutcome.value;
  }),
}));

const alerts: Array<{ type: string; severity: string; message: string }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: { type: string; severity: string; message: string }) => {
    alerts.push(alert);
  }),
}));

// The authoritative record of what was actually spent. Controlled per test so
// the "webhook was thin" path can be driven deliberately.
const transactionResponse: { value: unknown } = { value: null };
// KEYED BY TRANSACTION ID, because the monotonicity guard now reads back the
// RECORDED transaction as well as the incoming one — the only way to compare
// two creation times on the same clock. A single shared response would let a
// test pass by accident on the wrong lookup.
const transactionsById: Record<string, unknown> = {};
vi.mock("@/lib/shippo/client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTransaction: vi.fn(async (id: string) => {
      const keyed = transactionsById[String(id)];
      if (keyed) return { ok: true, data: keyed };
      return transactionResponse.value
        ? { ok: true, data: transactionResponse.value }
        : { ok: false, kind: "unavailable", message: "Shippo unreachable", safeToRetry: true };
    }),
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
    label_voided_at: null,
    label_purchased_at: null,
    ...overrides,
  };
  state.updates = [];
  state.costCalls = [];
  transactionResponse.value = null;
  for (const key of Object.keys(transactionsById)) delete transactionsById[key];
  costOutcome.value = { ok: true };
  alerts.length = 0;
}

/** The label really cost $8.45. That number must survive to the order. */
const EXPANDED_RATE = { amount: "8.45", provider: "USPS", servicelevel: { name: "Ground Advantage" } };

const withExpandedRate = {
  status: "SUCCESS",
  object_id: "shippo-txn-1",
  // WHEN SHIPPO MADE THIS TRANSACTION. The ordering key that tells a genuine
  // replacement label apart from a late delivery for an older one — see the
  // "out-of-order deliveries" block at the end of this file.
  object_created: "2026-08-23T10:00:00Z",
  order: "shippo-order-1",
  tracking_number: "9400100000000000000000",
  label_url: "https://example.invalid/label.pdf",
  rate: EXPANDED_RATE,
};

/** Exactly what production sent: a rate that is only an id. */
const withStringRate = {
  status: "SUCCESS",
  object_id: "shippo-txn-1",
  object_created: "2026-08-23T10:00:00Z",
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

// ---------------------------------------------------------------------------
// A REPLACEMENT LABEL BOUGHT IN THE DASHBOARD AFTER AN IN-APP VOID.
//
// voidLabelForOrder stamps label_voided_at and keeps it there. The in-app
// re-buy clears it; this path did not. So the order kept a live label on a row
// still marked voided — recordActualShippingCost refuses to cost such a row and
// the repair sweep filters it out, which meant real postage was never charged
// to profit and nothing anywhere said so, because the refusal is a RETURN
// VALUE and the only handler here was a .catch().
// ---------------------------------------------------------------------------
describe("a replacement label after a void", () => {
  it("clears label_voided_at, so the new label's cost can actually be recorded", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-VOIDED",
      label_voided_at: "2026-08-22T09:00:00Z",
      // The voided label was recorded on the 22nd; the replacement below was
      // created by Shippo on the 23rd, so it is genuinely newer.
      label_purchased_at: "2026-08-22T08:00:00Z",
      fulfillment_status: "packed",
    });

    await applyTransactionCreated(withExpandedRate as never);

    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect(written.shippo_transaction_id).toBe("shippo-txn-1");
    expect(written.label_voided_at).toBeNull();
    expect(state.costCalls).toHaveLength(1);
    expect(state.costCalls[0]).toMatchObject({ amountCents: 845 });
  });

  it("does NOT un-void on a redelivery of the voided label's own event", async () => {
    // Same object_id as the label that was voided. Un-voiding here would put
    // the refunded postage straight back into profit.
    seed({
      shippo_transaction_id: "shippo-txn-1",
      label_voided_at: "2026-08-22T09:00:00Z",
      fulfillment_status: "packed",
    });

    await applyTransactionCreated(withExpandedRate as never);

    const written = Object.assign({}, ...state.updates) as Record<string, unknown>;
    expect("label_voided_at" in written).toBe(false);
    expect(state.order?.label_voided_at).toBe("2026-08-22T09:00:00Z");
  });

  it("does not discard a refused cost write — it names the order in an alert", async () => {
    seed({ shippo_transaction_id: "shippo-txn-1", label_voided_at: "2026-08-22T09:00:00Z" });
    costOutcome.value = { ok: false, error: "This order's label was voided" };

    await applyTransactionCreated(withExpandedRate as never);

    expect(state.costCalls).toHaveLength(1);
    const unrecorded = alerts.find((alert) => alert.type === "shipping_cost_unrecorded");
    expect(unrecorded).toBeDefined();
    expect(unrecorded!.message).toContain("ord-cost-1");
  });

  it("raises nothing when the cost is recorded normally", async () => {
    seed();
    await applyTransactionCreated(withExpandedRate as never);
    expect(alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OUT-OF-ORDER DELIVERIES — FIX WAVE 3.
//
// The route-level event_key dedupe only blocks a redelivery of the transaction
// CURRENTLY on the row, and "different transaction id" used to be read as "this
// is a replacement label". Every other stale shape was therefore wide open:
//
//   t0  T1 bought           -> transaction T1, postage 742 recorded
//   t1  T1 voided in-app    -> label_voided_at set, cost nulled
//   t2  T2 bought           -> transaction T2, void cleared, postage 1200
//   t3  T1's transaction_created finally arrives (never seen, so not deduped)
//
// At t3 the VOIDED label was classified as the replacement: the void was
// cleared, the order was pointed back at the dead transaction, the voided
// label's tracking number and printable label_url were restored onto a live
// order, and a CORRECT recorded cost was overwritten with the refunded one
// while profit_finalized stayed true.
// ---------------------------------------------------------------------------
describe("a late transaction_created for an OLDER label", () => {
  /** T1, bought and voided before the live label T2 landed. */
  const staleVoidedLabel = {
    status: "SUCCESS",
    object_id: "shippo-txn-VOIDED",
    object_created: "2026-08-22T07:00:00Z",
    order: "shippo-order-1",
    tracking_number: "TRACK-VOIDED",
    label_url: "https://example.invalid/label-VOIDED.pdf",
    rate: { amount: "7.42", provider: "USPS", servicelevel: { name: "Ground Advantage" } },
  };

  it("does not overwrite the live label's transaction, tracking, url or cost", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-2",
      tracking_number: "TRACK-LIVE",
      label_url: "https://example.invalid/label-LIVE.pdf",
      postage_cost_cents: 1200,
      label_purchased_at: "2026-08-23T10:00:05Z",
      fulfillment_status: "label_purchased",
    });
    // The live label, as SHIPPO records it. Both sides of the comparison come
    // from the same clock now.
    transactionsById["shippo-txn-2"] = { status: "SUCCESS", object_id: "shippo-txn-2", object_created: "2026-08-23T09:55:00Z" };

    const outcome = await applyTransactionCreated(staleVoidedLabel as never);

    expect(outcome).toMatchObject({ matched: true, reason: "stale_transaction" });
    expect(state.updates).toHaveLength(0);
    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-2");
    expect(state.order?.tracking_number).toBe("TRACK-LIVE");
    expect(state.order?.label_url).toBe("https://example.invalid/label-LIVE.pdf");
    expect(state.order?.postage_cost_cents).toBe(1200);
    // And no money is written for the dead label.
    expect(state.costCalls).toHaveLength(0);
  });

  it("does not clear label_voided_at on a row that is still voided", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-1",
      label_voided_at: "2026-08-22T09:00:00Z",
      label_purchased_at: "2026-08-22T08:00:00Z",
      fulfillment_status: "packed",
    });
    transactionsById["shippo-txn-1"] = { status: "SUCCESS", object_id: "shippo-txn-1", object_created: "2026-08-22T07:30:00Z" };

    // An even older transaction — T0 — arriving late. Different id, so the old
    // rule called it a replacement and un-voided the order outright.
    await applyTransactionCreated({ ...staleVoidedLabel, object_id: "shippo-txn-0", object_created: "2026-08-21T07:00:00Z" } as never);

    expect(state.order?.label_voided_at).toBe("2026-08-22T09:00:00Z");
    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-1");
  });

  it("is never silent about it", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-2",
      label_purchased_at: "2026-08-23T10:00:05Z",
      fulfillment_status: "label_purchased",
    });
    transactionsById["shippo-txn-2"] = { status: "SUCCESS", object_id: "shippo-txn-2", object_created: "2026-08-23T09:55:00Z" };

    await applyTransactionCreated(staleVoidedLabel as never);

    const ignored = alerts.find((alert) => alert.type === "shippo_stale_transaction_ignored");
    expect(ignored).toBeDefined();
    expect(ignored!.message).toContain("ord-cost-1");
  });

  it("still accepts a genuinely newer replacement", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-VOIDED",
      label_voided_at: "2026-08-22T09:00:00Z",
      label_purchased_at: "2026-08-22T08:00:00Z",
      fulfillment_status: "packed",
    });
    transactionsById["shippo-txn-VOIDED"] = { status: "REFUNDED", object_id: "shippo-txn-VOIDED", object_created: "2026-08-22T07:00:00Z" };

    await applyTransactionCreated(withExpandedRate as never);

    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-1");
    expect(state.order?.label_voided_at).toBeNull();
    expect(state.costCalls).toHaveLength(1);
  });

  // ------------------------------------------------------------------------
  // F-8: THE GUARD USED TO COMPARE TWO DIFFERENT CLOCKS.
  //
  // `orders.label_purchased_at` is RECEIPT time (`now`), written when the
  // delivery lands — not the transaction's creation time. Shippo replays late,
  // so a delayed T1 delivery pushes label_purchased_at ahead of a genuine
  // replacement T2 that was bought EARLIER in wall-clock terms but is the live
  // label. The old comparison then refused T2 as stale: the order kept the dead
  // transaction, T2's postage was never recorded, and the only signal was a
  // warning with no email.
  // ------------------------------------------------------------------------
  it("accepts a live replacement whose predecessor's webhook arrived late (F-8)", async () => {
    seed({
      // T1's transaction_created was delivered ten minutes late, so the LOCAL
      // receipt time on the row runs well ahead of the remote creation time.
      shippo_transaction_id: "shippo-txn-LATE",
      label_purchased_at: "2026-08-23T10:10:00Z",
      postage_cost_cents: 742,
      fulfillment_status: "label_purchased",
    });
    // On SHIPPO's clock, T1 was created at 10:00 and the replacement at 10:03.
    transactionsById["shippo-txn-LATE"] = { status: "SUCCESS", object_id: "shippo-txn-LATE", object_created: "2026-08-23T10:00:00Z" };
    const replacement = { ...withExpandedRate, object_id: "shippo-txn-REPLACEMENT", object_created: "2026-08-23T10:03:00Z" };

    const outcome = await applyTransactionCreated(replacement as never);

    expect(outcome).not.toMatchObject({ reason: "stale_transaction" });
    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-REPLACEMENT");
    // The real postage for the live label reaches profit.
    expect(state.costCalls).toHaveLength(1);
    expect(state.costCalls[0]).toMatchObject({ amountCents: 845 });
  });

  it("still refuses an older transaction once both creation times come from Shippo", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-LIVE",
      label_purchased_at: "2026-08-23T10:10:00Z",
      postage_cost_cents: 1200,
      fulfillment_status: "label_purchased",
    });
    transactionsById["shippo-txn-LIVE"] = { status: "SUCCESS", object_id: "shippo-txn-LIVE", object_created: "2026-08-23T10:05:00Z" };
    const older = { ...withExpandedRate, object_id: "shippo-txn-OLDER", object_created: "2026-08-23T09:00:00Z" };

    const outcome = await applyTransactionCreated(older as never);

    expect(outcome).toMatchObject({ reason: "stale_transaction" });
    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-LIVE");
    expect(state.costCalls).toHaveLength(0);
  });

  it("falls back to Shippo's live status when the delivery carries no timestamp", async () => {
    seed({
      shippo_transaction_id: "shippo-txn-2",
      postage_cost_cents: 1200,
      label_purchased_at: "2026-08-23T10:00:05Z",
      fulfillment_status: "label_purchased",
    });
    // Shippo now reports the incoming transaction as REFUNDED — a voided label.
    transactionResponse.value = { status: "REFUNDED", rate: { amount: "7.42" } };

    const noTimestamp: Record<string, unknown> = { ...staleVoidedLabel };
    delete noTimestamp.object_created;
    const outcome = await applyTransactionCreated(noTimestamp as never);

    expect(outcome).toMatchObject({ reason: "stale_transaction" });
    expect(state.order?.postage_cost_cents).toBe(1200);
  });

  // A first label is not a stale one: there is nothing on the row to move
  // backwards from.
  it("never blocks the first label an order ever gets", async () => {
    seed();
    await applyTransactionCreated(withExpandedRate as never);
    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-1");
    expect(state.costCalls).toHaveLength(1);
  });

  // A thin delivery with no object_id must not BLANK a recorded transaction id:
  // that leaves a label_purchased_at row with no transaction, which nothing can
  // repair and which the shipping sweep cannot even see.
  it("does not blank a recorded transaction id when the delivery names none", async () => {
    seed({ shippo_transaction_id: "shippo-txn-2", label_purchased_at: "2026-08-23T10:00:05Z" });

    await applyTransactionCreated({ status: "SUCCESS", order: "shippo-order-1", rate: EXPANDED_RATE } as never);

    expect(state.order?.shippo_transaction_id).toBe("shippo-txn-2");
  });
});
