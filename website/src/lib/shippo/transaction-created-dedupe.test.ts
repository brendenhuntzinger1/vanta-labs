import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// D-02 — THE LABEL WEBHOOK THAT RE-RUNS ITSELF ON EVERY REDELIVERY.
//
// The tracking path claims its event key BEFORE doing any work, so a redelivered
// scan is a no-op. transaction_created did the opposite: it ran the whole
// handler and only afterwards UPSERTed the event row, and nothing ever read that
// row back. So every redelivery of the same label:
//
//   - moved label_purchased_at to now()
//   - re-ran recordActualShippingCost, re-setting profit_finalized=true and
//     inserting ANOTHER order_shipping_cost_audit row
//   - resurrected a cost on a label that had since been VOIDED
//
// Shippo retries on any non-2xx, so this is not hypothetical.
//
// These tests drive the REAL POST handler.
// ---------------------------------------------------------------------------

const applyTransactionCreated = vi.fn(async (): Promise<{
  matched: boolean;
  orderId: string | null;
  reason?: string;
}> => ({ matched: true, orderId: "order-1" }));

const applyTrackingUpdate = vi.fn(async () => ({
  ok: true as const,
  data: { duplicate: false, handled: true, statusChanged: false, orderId: "order-1", to: "in_transit" },
}));

const recordSystemAlert = vi.fn(async () => {});

// The event-key table, behaving like Postgres: a unique index on event_key.
const claimedKeys = new Set<string>();
const insertedRows: Record<string, unknown>[] = [];

vi.mock("@/lib/shippo/order-sync", () => ({ applyTransactionCreated }));
vi.mock("@/lib/shippo/service", () => ({ applyTrackingUpdate }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "shippo_webhook_events") {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = String(row.event_key);
            if (claimedKeys.has(key)) {
              return { error: { code: "23505", message: "duplicate key value" } };
            }
            claimedKeys.add(key);
            insertedRows.push(row);
            return { error: null };
          },
          upsert: async (row: Record<string, unknown>) => {
            claimedKeys.add(String(row.event_key));
            insertedRows.push(row);
            return { error: null };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({
            eq: (_c: string, v: string) => {
              const done = () => {
                claimedKeys.delete(v);
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
      return {
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      };
    },
  },
}));

const SECRET = "correct-horse-battery-staple";
const URL_BASE = "https://example.test/api/webhooks/shippo";

const LABEL_EVENT = {
  event: "transaction_created",
  data: {
    object_id: "txn_dedupe_1",
    status: "SUCCESS",
    tracking_number: "1Z-DEDUPE",
    rate: { amount: "7.43", provider: "USPS", servicelevel: { name: "Ground" } },
  },
};

function post(body: unknown) {
  return new Request(`${URL_BASE}?secret=${encodeURIComponent(SECRET)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callPost(request: Request) {
  const { POST } = await import("@/app/api/webhooks/shippo/route");
  return POST(request);
}

const originalSecret = process.env.SHIPPO_WEBHOOK_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  claimedKeys.clear();
  insertedRows.length = 0;
  process.env.SHIPPO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SHIPPO_WEBHOOK_SECRET;
  else process.env.SHIPPO_WEBHOOK_SECRET = originalSecret;
});

describe("a redelivered transaction_created", () => {
  it("runs the label handler exactly once for the same transaction", async () => {
    const first = await callPost(post(LABEL_EVENT));
    expect(first.status).toBe(200);
    expect(applyTransactionCreated).toHaveBeenCalledTimes(1);

    const second = await callPost(post(LABEL_EVENT));
    expect(second.status).toBe(200);

    // The whole point: the second delivery must not re-run the write that
    // moves label_purchased_at and re-finalises profit.
    expect(applyTransactionCreated).toHaveBeenCalledTimes(1);
  });

  it("reports the redelivery as a duplicate rather than a fresh match", async () => {
    await callPost(post(LABEL_EVENT));
    const second = await callPost(post(LABEL_EVENT));
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.duplicate).toBe(true);
  });

  it("still processes a genuinely different transaction", async () => {
    await callPost(post(LABEL_EVENT));
    await callPost(
      post({ ...LABEL_EVENT, data: { ...LABEL_EVENT.data, object_id: "txn_dedupe_2" } }),
    );
    expect(applyTransactionCreated).toHaveBeenCalledTimes(2);
  });

  it("releases the claim when the handler throws, so Shippo's retry can re-run it", async () => {
    applyTransactionCreated.mockRejectedValueOnce(new Error("transient failure"));

    const first = await callPost(post(LABEL_EVENT));
    expect(first.status).toBe(500);

    // The retry must genuinely re-run rather than be swallowed as a duplicate.
    const retry = await callPost(post(LABEL_EVENT));
    expect(retry.status).toBe(200);
    expect(applyTransactionCreated).toHaveBeenCalledTimes(2);
  });
});
