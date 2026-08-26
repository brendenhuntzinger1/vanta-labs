import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PARCEL'S JOURNEY, AND THE EXACTLY-ONE EMAIL IT EARNS.
//
// applyTrackingUpdate is the only thing that turns a carrier scan into a
// status the owner and customer see, and into the two emails Vanta ever sends
// about a shipment. Four ways it can go wrong, all silent:
//
//   - a scan that should not move the order moves it anyway
//   - a delivered order is walked backwards by a late scan
//   - one journey earns four emails instead of two
//   - a transient email outage loses the tracking email FOR GOOD, because the
//     status has already advanced and no later scan produces another one
//
// WHY THIS FILE EXISTS
//
// Dropping the enqueueFailedEmail call -- so a failed send is logged and
// forgotten -- left all 2,717 existing tests green.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-track-0001";

const state: {
  fulfillmentStatus: string;
  shippedAt: string | null;
  claimedKeys: Set<string>;
  updates: Record<string, unknown>[];
  emailSucceeds: boolean;
} = {
  fulfillmentStatus: "label_purchased",
  shippedAt: null,
  claimedKeys: new Set(),
  updates: [],
  emailSucceeds: true,
};

const { sendEmail, enqueueFailedEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  enqueueFailedEmail: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", async () => {
  // Postgres-faithful update semantics: see the double's own header.
  const { ordersUpdateDouble } = await import("./test-support/orders-table-double");
  const from = (table: string) => {
    if (table === "shippo_webhook_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const key = String(row.event_key);
          if (state.claimedKeys.has(key)) {
            return { error: { code: "23505", message: "duplicate key" } };
          }
          state.claimedKeys.add(key);
          return { error: null };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({
          eq: (_c: string, v: string) => {
            const done = () => {
              state.claimedKeys.delete(v);
              return { error: null };
            };
            return {
              is: async () => done(),
              then: (r: (x: { error: null }) => unknown) => Promise.resolve(done()).then(r),
            };
          },
        }),
      };
    }
    if (table === "orders") {
      const row = () => ({
        order_id: ORDER_ID,
        order_number: "VL-TRACK01",
        customer_email: "buyer@example.test",
        customer_name: "A Buyer",
        fulfillment_status: state.fulfillmentStatus,
        tracking_number: "TRK0001",
        shipping_carrier: "USPS",
        shipped_at: state.shippedAt,
      });
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            or() { return b; },
            limit() { return b; },
            order() { return b; },
            async maybeSingle() { return { data: row(), error: null }; },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              return Promise.resolve({ data: [row()], error: null }).then(resolve);
            },
          };
          return b;
        },
        update: ordersUpdateDouble({
          currentStatus: () => state.fulfillmentStatus,
          onCommit: (payload) => {
            state.updates.push(payload);
            if (typeof payload.fulfillment_status === "string") {
              state.fulfillmentStatus = payload.fulfillment_status;
            }
            if (payload.shipped_at) state.shippedAt = String(payload.shipped_at);
          },
        }),
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

function scan(status: string, opts: { key?: string } = {}) {
  scanSeq += 1;
  return {
    event: "track_updated",
    data: {
      transaction: "txn_track_1",
      tracking_number: "TRK0001",
      carrier: "usps",
      tracking_status: {
        status,
        object_id: opts.key ?? `scan-${scanSeq}`,
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
  sendEmail.mockImplementation(async () =>
    state.emailSucceeds ? { success: true } : { success: false, error: "provider unavailable" },
  );
  state.fulfillmentStatus = "label_purchased";
  state.shippedAt = null;
  state.claimedKeys = new Set();
  state.updates = [];
  state.emailSucceeds = true;
  scanSeq = 0;
});

describe("the ordinary journey", () => {
  it("moves label_purchased to in_transit on the first movement scan", async () => {
    const result = await apply(scan("TRANSIT"));
    expect(result.ok).toBe(true);
    expect(state.fulfillmentStatus).toBe("in_transit");
  });

  it("sends exactly ONE shipping email for the whole carrier journey", async () => {
    await apply(scan("TRANSIT"));
    await apply(scan("OUT_FOR_DELIVERY"));
    // Entering the carrier network is one event however many scans describe it.
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends exactly ONE delivery email, separate from the shipping one", async () => {
    await apply(scan("TRANSIT"));
    const afterShipping = sendEmail.mock.calls.length;
    await apply(scan("DELIVERED"));
    expect(state.fulfillmentStatus).toBe("delivered");
    expect(sendEmail.mock.calls.length).toBe(afterShipping + 1);
  });

  it("emails twice in total across a full journey, not four times", async () => {
    await apply(scan("PRE_TRANSIT"));
    await apply(scan("TRANSIT"));
    await apply(scan("OUT_FOR_DELIVERY"));
    await apply(scan("DELIVERED"));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("stamps shipped_at once and never writes it again", async () => {
    await apply(scan("TRANSIT"));
    expect(state.updates[0]).toHaveProperty("shipped_at");
    expect(state.shippedAt).toBeTruthy();

    await apply(scan("OUT_FOR_DELIVERY"));
    // Asserting the VALUE is unchanged is not enough -- two scans in the same
    // millisecond produce an identical timestamp, so a re-stamp would look
    // like a no-op. The proof is that the column is not in the payload at all.
    expect(state.updates[1]).not.toHaveProperty("shipped_at");
  });
});

describe("a redelivered scan", () => {
  it("is refused by the event key and changes nothing", async () => {
    const payload = scan("TRANSIT", { key: "same-scan" });
    await apply(payload);
    const statusAfterFirst = state.fulfillmentStatus;
    const emailsAfterFirst = sendEmail.mock.calls.length;

    const second = await apply(payload);

    expect(second.ok).toBe(true);
    expect(second.ok && second.data.duplicate).toBe(true);
    expect(state.fulfillmentStatus).toBe(statusAfterFirst);
    expect(sendEmail.mock.calls.length).toBe(emailsAfterFirst);
  });

  it("does not send a second shipping email for a repeated TRANSIT with a new key", async () => {
    await apply(scan("TRANSIT"));
    const afterFirst = sendEmail.mock.calls.length;
    // A genuinely different scan, same meaning: the transition is "unchanged",
    // so no second email.
    await apply(scan("TRANSIT"));
    expect(sendEmail.mock.calls.length).toBe(afterFirst);
  });
});

describe("delivered is the end of the story", () => {
  for (const late of ["TRANSIT", "PRE_TRANSIT", "OUT_FOR_DELIVERY"]) {
    it(`ignores a late ${late} scan after delivery`, async () => {
      await apply(scan("DELIVERED"));
      expect(state.fulfillmentStatus).toBe("delivered");
      const emailsAfterDelivery = sendEmail.mock.calls.length;

      await apply(scan(late));

      expect(state.fulfillmentStatus).toBe("delivered");
      expect(sendEmail.mock.calls.length).toBe(emailsAfterDelivery);
    });
  }

  it("does not send a second delivery email for a repeated DELIVERED", async () => {
    await apply(scan("DELIVERED"));
    const afterFirst = sendEmail.mock.calls.length;
    await apply(scan("DELIVERED"));
    expect(sendEmail.mock.calls.length).toBe(afterFirst);
  });
});

describe("an unrecognised scan", () => {
  it("is dropped rather than guessed onto the nearest status", async () => {
    const result = await apply(scan("SOMETHING_NEW"));
    expect(result.ok).toBe(true);
    expect(state.fulfillmentStatus).toBe("label_purchased");
    expect(state.updates).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("ignores an event that is not track_updated", async () => {
    const result = await apply({ ...scan("TRANSIT"), event: "transaction_created" });
    expect(result.ok).toBe(true);
    expect(state.fulfillmentStatus).toBe("label_purchased");
  });
});

describe("when the email provider is down", () => {
  it("QUEUES the shipping email for retry instead of losing it", async () => {
    state.emailSucceeds = false;
    await apply(scan("TRANSIT"));
    // The status has already advanced, so no later scan will produce another
    // email. Logging alone would cost the customer their tracking notice for
    // good.
    expect(enqueueFailedEmail).toHaveBeenCalledTimes(1);
  });

  it("QUEUES the delivery email for retry too", async () => {
    state.emailSucceeds = false;
    await apply(scan("DELIVERED"));
    expect(enqueueFailedEmail).toHaveBeenCalledTimes(1);
  });

  it("still advances the shipment — a failed email must not undo a real scan", async () => {
    state.emailSucceeds = false;
    await apply(scan("TRANSIT"));
    expect(state.fulfillmentStatus).toBe("in_transit");
  });

  it("does not queue anything when the send succeeds", async () => {
    await apply(scan("TRANSIT"));
    expect(enqueueFailedEmail).not.toHaveBeenCalled();
  });
});
