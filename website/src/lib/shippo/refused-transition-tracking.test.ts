import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// F-16-02. A REFUSED TRANSITION MUST NOT DISCARD THE TRACKING NUMBER.
//
// applyTrackingUpdate refuses a scan whose status the order has already passed
// ("unchanged", "terminal", "regression") — correct, and normal for an
// at-least-once, out-of-order feed. But it returned right there, having written
// NOTHING, and marked the event processed so Shippo never redelivers it.
//
// The status is a claim about progress. The TRACKING NUMBER is a fact about the
// parcel, true whenever it arrives. An order whose label was bought in the
// Shippo dashboard holds no tracking number locally, and its first scan is
// routinely one of these refused shapes — so the number went in the bin and the
// customer's tracking link stayed empty on an order that really did ship.
//
// order-sync.ts already separates label FACTS from the status move for exactly
// this reason. This pins the same rule on the tracking path.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-refused-0001";

const state: {
  fulfillmentStatus: string;
  trackingNumber: string | null;
  shippingCarrier: string | null;
  updates: Record<string, unknown>[];
  shipmentUpserts: Record<string, unknown>[];
  claimedKeys: Set<string>;
  /** A number another writer lands just before this event's write commits. */
  raceOnCommit: string | null;
} = {
  fulfillmentStatus: "delivered",
  trackingNumber: null,
  shippingCarrier: null,
  updates: [],
  shipmentUpserts: [],
  claimedKeys: new Set(),
  raceOnCommit: null,
};

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ success: true })) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "shippo_webhook_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const key = String(row.event_key);
          if (state.claimedKeys.has(key)) return { error: { code: "23505", message: "duplicate key" } };
          state.claimedKeys.add(key);
          return { error: null };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({
          eq: () => ({ is: async () => ({ error: null }), then: (r: (x: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }),
        }),
      };
    }
    if (table === "orders") {
      const row = () => ({
        order_id: ORDER_ID,
        order_number: "VL-REFUSE1",
        customer_email: "buyer@example.test",
        customer_name: "A Buyer",
        fulfillment_status: state.fulfillmentStatus,
        tracking_number: state.trackingNumber,
        shipping_carrier: state.shippingCarrier,
        shipped_at: "2026-08-20T00:00:00Z",
      });
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            or() { return b; },
            limit() { return b; },
            order() { return b; },
            async maybeSingle() { return { data: row(), error: null }; },
          };
          return b;
        },
        // Postgres-faithful enough for the compare-and-set: the UPDATE lands
        // only if the row still holds the tracking number the caller filtered
        // on, exactly as the real guarded write behaves.
        update: (payload: Record<string, unknown>) => {
          let expectedTracking: string | null | undefined;
          const commit = () => {
            // A one-shot concurrent writer landing between this event's read of
            // the order and its write — the race the compare-and-set exists for.
            if (state.raceOnCommit !== null) {
              state.trackingNumber = state.raceOnCommit;
              state.raceOnCommit = null;
            }
            const matches =
              expectedTracking === undefined
              || (expectedTracking === null
                ? state.trackingNumber === null
                : state.trackingNumber === expectedTracking);
            if (!matches) return { data: [], error: null };
            state.updates.push(payload);
            if (typeof payload.tracking_number === "string") state.trackingNumber = payload.tracking_number;
            if (typeof payload.shipping_carrier === "string") state.shippingCarrier = payload.shipping_carrier;
            return { data: [{ order_id: ORDER_ID }], error: null };
          };
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              if (column === "tracking_number") expectedTracking = value as string;
              return chain;
            },
            is: (column: string) => {
              if (column === "tracking_number") expectedTracking = null;
              return chain;
            },
            select: async () => commit(),
            then: (r: (x: unknown) => unknown) => Promise.resolve(commit()).then((res) => r({ error: res.error })),
          };
          return chain;
        },
      };
    }
    if (table === "order_shipments") {
      return {
        upsert: async (row: Record<string, unknown>) => {
          state.shipmentUpserts.push(row);
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

let scanSeq = 0;

/** A carrier scan for a parcel whose number this order does not hold yet. */
function scan(status: string, opts: { trackingNumber?: string | null; carrier?: string } = {}) {
  scanSeq += 1;
  return {
    event: "track_updated",
    data: {
      transaction: "txn_refused_1",
      tracking_number: opts.trackingNumber === undefined ? "TRK-DASHBOARD-9" : opts.trackingNumber,
      carrier: opts.carrier ?? "usps",
      tracking_status: {
        status,
        object_id: `scan-${scanSeq}`,
        status_date: `2026-08-2${scanSeq % 10}T00:00:00Z`,
      },
    },
  };
}

async function apply(payload: unknown) {
  const { applyTrackingUpdate } = await import("@/lib/shippo/service");
  return applyTrackingUpdate(payload as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.fulfillmentStatus = "delivered";
  state.trackingNumber = null;
  state.shippingCarrier = null;
  state.updates = [];
  state.shipmentUpserts = [];
  state.claimedKeys = new Set();
  state.raceOnCommit = null;
  scanSeq = 0;
});

describe("a scan the pipeline refuses still keeps the parcel's facts", () => {
  it("records a tracking number the order did not have", async () => {
    // "delivered" is terminal, so this in-transit scan is refused.
    const result = await apply(scan("TRANSIT"));

    expect(result.ok).toBe(true);
    expect(state.trackingNumber).toBe("TRK-DASHBOARD-9");
  });

  it("fills a carrier the order did not have", async () => {
    await apply(scan("TRANSIT"));
    expect(state.shippingCarrier).toBe("usps");
  });

  it("does not move the order, write a status, or email anybody", async () => {
    const result = await apply(scan("TRANSIT"));

    expect(state.fulfillmentStatus).toBe("delivered");
    expect(state.updates.every((update) => !("fulfillment_status" in update))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.ok && result.data.statusChanged).toBe(false);
  });

  it("keeps the shipment row in step with the number it just learned", async () => {
    await apply(scan("TRANSIT"));
    expect(state.shipmentUpserts).toHaveLength(1);
    expect(state.shipmentUpserts[0]).toMatchObject({
      order_id: ORDER_ID,
      tracking_number: "TRK-DASHBOARD-9",
    });
  });

  it("never overwrites a carrier already recorded from the purchased rate", async () => {
    // "USPS" from the rate is better data than the webhook's free-text "usps".
    state.shippingCarrier = "USPS";
    await apply(scan("TRANSIT", { carrier: "usps" }));
    expect(state.shippingCarrier).toBe("USPS");
  });

  it("writes nothing at all when the refused scan carries no new number", async () => {
    state.trackingNumber = "TRK-DASHBOARD-9";
    await apply(scan("TRANSIT"));
    expect(state.updates).toHaveLength(0);
  });

  it("never overwrites a number another writer set between the read and the write", async () => {
    // The write is a compare-and-set on the value this decision was read
    // against, so a number that landed in between — a concurrent scan, or the
    // label path — is never clobbered by this stale event's copy.
    state.raceOnCommit = "TRK-WRITTEN-BY-SOMEBODY-ELSE";

    const result = await apply(scan("TRANSIT"));

    expect(result.ok).toBe(true);
    expect(state.trackingNumber).toBe("TRK-WRITTEN-BY-SOMEBODY-ELSE");
    expect(state.shipmentUpserts).toHaveLength(0);
  });

  it("writes nothing at all when the refused scan carries no number", async () => {
    await apply(scan("TRANSIT", { trackingNumber: null }));
    expect(state.updates).toHaveLength(0);
    expect(state.trackingNumber).toBeNull();
  });
});
