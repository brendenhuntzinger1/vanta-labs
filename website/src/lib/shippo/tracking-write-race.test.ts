import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// D-01 — THE WRITE THAT IGNORES WHAT THE STATE MACHINE JUST DECIDED.
//
// order-pipeline.ts refuses to walk a delivered order backwards, and
// applyTrackingUpdate asks it before every write. But the write itself is a
// read-modify-write with no guard on the row it read:
//
//     .update({ fulfillment_status }).eq("order_id", id)
//
// Two DIFFERENT scans have two different event_keys, so both clear the
// idempotency claim and can run at once. Each decides against its own snapshot.
// If DELIVERED commits while TRANSIT is between its read and its write, TRANSIT
// overwrites it — and the order regresses delivered -> in_transit, which is
// precisely the outcome the pipeline exists to prevent.
//
// This is NOT two sequential calls. The gate below holds the TRANSIT scan
// between its read and its write while the DELIVERED scan runs to completion.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-race-0001";

type Gate = { promise: Promise<void>; release: () => void };

function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const state: {
  fulfillmentStatus: string;
  deliveredAt: string | null;
  shippedAt: string | null;
  claimedKeys: Set<string>;
  historyRows: Record<string, unknown>[];
  gate: Gate | null;
  gateArmedFor: string | null;
} = {
  fulfillmentStatus: "label_purchased",
  deliveredAt: null,
  shippedAt: null,
  claimedKeys: new Set(),
  historyRows: [],
  gate: null,
  gateArmedFor: null,
};

const { sendEmail, enqueueFailedEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  enqueueFailedEmail: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", () => {
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
            const b: Record<string, unknown> = {
              is: async () => done(),
              then: (resolve: (x: { error: null }) => unknown) => Promise.resolve(done()).then(resolve),
            };
            return b;
          },
        }),
      };
    }

    if (table === "orders") {
      const row = () => ({
        order_id: ORDER_ID,
        order_number: "VL-RACE01",
        customer_email: "buyer@example.test",
        customer_name: "A Buyer",
        fulfillment_status: state.fulfillmentStatus,
        tracking_number: "TRK-RACE",
        shipping_carrier: "USPS",
        shipped_at: state.shippedAt,
        delivered_at: state.deliveredAt,
      });

      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            or() { return b; },
            limit() { return b; },
            order() { return b; },
            async maybeSingle() {
              const snapshot = row();
              // Hold THIS reader between its read and its write, so another
              // scan can commit underneath it.
              if (state.gate && state.gateArmedFor === snapshot.fulfillment_status) {
                state.gateArmedFor = null;
                await state.gate.promise;
              }
              return { data: snapshot, error: null };
            },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              return Promise.resolve({ data: [row()], error: null }).then(resolve);
            },
          };
          return b;
        },

        // A faithful stand-in for Postgres: the UPDATE applies only to rows
        // still matching every predicate at write time, and reports back which
        // rows it actually touched.
        update: (payload: Record<string, unknown>) => {
          const predicates: Record<string, unknown> = {};
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              predicates[column] = value;
              return builder;
            },
            select() {
              return builder;
            },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve(commit()).then(resolve);
            },
          };

          function commit(): { data: unknown[]; error: null } {
            const guarded = Object.prototype.hasOwnProperty.call(predicates, "fulfillment_status");
            if (guarded && predicates.fulfillment_status !== state.fulfillmentStatus) {
              // Somebody else moved the row first. Postgres matches nothing.
              return { data: [], error: null };
            }
            if (typeof payload.fulfillment_status === "string") {
              state.fulfillmentStatus = payload.fulfillment_status;
            }
            if (payload.shipped_at) state.shippedAt = String(payload.shipped_at);
            if (payload.delivered_at) state.deliveredAt = String(payload.delivered_at);
            return { data: [{ order_id: ORDER_ID }], error: null };
          }

          return builder;
        },
      };
    }

    if (table === "order_status_history") {
      return {
        insert: async (rows: unknown) => {
          for (const r of Array.isArray(rows) ? rows : [rows]) {
            state.historyRows.push(r as Record<string, unknown>);
          }
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

function scan(status: string, id: string) {
  return {
    event: "track_updated",
    data: {
      transaction: "txn_race_1",
      tracking_number: "TRK-RACE",
      carrier: "usps",
      tracking_status: { status, object_id: id, status_date: `2026-08-2${id.length}T00:00:00Z` },
    },
  };
}

async function apply(payload: unknown) {
  const { applyTrackingUpdate } = await import("@/lib/shippo/service");
  return applyTrackingUpdate(payload as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.fulfillmentStatus = "label_purchased";
  state.deliveredAt = null;
  state.shippedAt = null;
  state.claimedKeys = new Set();
  state.historyRows = [];
  state.gate = null;
  state.gateArmedFor = null;
});

describe("two carrier scans landing at once", () => {
  it("does not let a slow TRANSIT scan walk a delivered order backwards", async () => {
    // Arm the gate so the first reader to see label_purchased stalls.
    state.gate = makeGate();
    state.gateArmedFor = "label_purchased";

    const slowTransit = apply(scan("TRANSIT", "scan-transit"));
    // Let the TRANSIT scan reach its read and block there.
    await new Promise((r) => setTimeout(r, 0));

    // DELIVERED runs start to finish while TRANSIT is parked.
    const delivered = await apply(scan("DELIVERED", "scan-delivered"));
    expect(delivered.ok).toBe(true);
    expect(state.fulfillmentStatus).toBe("delivered");
    expect(state.deliveredAt).not.toBeNull();

    // Now let the stale scan finish. It decided "in_transit" against a
    // snapshot that is no longer true.
    state.gate.release();
    await slowTransit;

    // The order must still be delivered.
    expect(state.fulfillmentStatus).toBe("delivered");
    expect(state.deliveredAt).not.toBeNull();
  });

  it("does not record a history row for a write that lost the race", async () => {
    state.gate = makeGate();
    state.gateArmedFor = "label_purchased";

    const slowTransit = apply(scan("TRANSIT", "scan-transit-2"));
    await new Promise((r) => setTimeout(r, 0));

    await apply(scan("DELIVERED", "scan-delivered-2"));
    state.gate.release();
    await slowTransit;

    const toInTransit = state.historyRows.filter((r) => r.to_status === "in_transit");
    expect(toInTransit).toHaveLength(0);
  });
});
