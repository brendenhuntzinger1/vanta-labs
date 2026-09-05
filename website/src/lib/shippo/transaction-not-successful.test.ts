import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// SHIP-03 — A NON-SUCCESS TRANSACTION IS NOT A PURCHASED LABEL.
//
// Shippo delivers transaction_created for every transaction object, including
// a purchase still QUEUED and one that failed with ERROR. The route treated
// every `!matched` outcome the same and raised the CRITICAL "a Shippo label was
// purchased that Vanta could not match to an order" alert (and its email) for
// them — false, since nothing was bought. It also kept the event claim, so a
// later delivery of the same object once it DID succeed was dropped as a
// duplicate. These tests drive the REAL POST handler.
// ---------------------------------------------------------------------------

const applyTransactionCreated = vi.fn(async (data: { status?: string }) =>
  String(data.status ?? "").toUpperCase() === "SUCCESS"
    ? { matched: false, orderId: null, reason: "no_matching_order" }
    : { matched: false, orderId: null, reason: "transaction_not_successful" });
const applyTrackingUpdate = vi.fn();
const recordSystemAlert = vi.fn(async () => {});

const claimedKeys = new Set<string>();
const eventRows: Record<string, unknown>[] = [];

vi.mock("@/lib/shippo/order-sync", () => ({ applyTransactionCreated }));
vi.mock("@/lib/shippo/service", () => ({ applyTrackingUpdate }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "shippo_webhook_events") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          const key = String(row.event_key);
          if (claimedKeys.has(key)) return { error: { code: "23505", message: "duplicate key value" } };
          claimedKeys.add(key);
          return { error: null };
        },
        upsert: async (row: Record<string, unknown>) => {
          claimedKeys.add(String(row.event_key));
          eventRows.push(row);
          return { error: null };
        },
        delete: () => ({
          eq: (_c: string, v: string) => ({
            is: async () => { claimedKeys.delete(v); return { error: null }; },
          }),
        }),
      };
    },
  },
}));

const SECRET = "correct-horse-battery-staple";
const URL_BASE = "https://example.test/api/webhooks/shippo";

function event(status: string, objectId = "txn_pending_1") {
  return {
    event: "transaction_created",
    data: { object_id: objectId, status, tracking_number: "", rate: { amount: "7.43" } },
  };
}

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
  eventRows.length = 0;
  process.env.SHIPPO_WEBHOOK_SECRET = SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SHIPPO_WEBHOOK_SECRET;
  else process.env.SHIPPO_WEBHOOK_SECRET = originalSecret;
});

describe("a transaction_created whose status is not SUCCESS", () => {
  it("does NOT raise the critical unattributed-label alert for a QUEUED purchase", async () => {
    const res = await callPost(post(event("QUEUED")));

    expect(res.status).toBe(200);
    expect(recordSystemAlert).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ received: true, matched: false, ignored: "transaction_not_successful", status: "QUEUED" });
  });

  it("does NOT raise it for an ERROR (failed) purchase either", async () => {
    await callPost(post(event("ERROR")));
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("logs the ignored delivery at warning level", async () => {
    await callPost(post(event("ERROR")));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("status ERROR is not a purchased label"),
      expect.objectContaining({ shippo_transaction: "txn_pending_1" }),
    );
  });

  it("releases the claim for a QUEUED purchase, so its later SUCCESS delivery is processed", async () => {
    await callPost(post(event("QUEUED")));
    expect(claimedKeys.has("transaction_created:txn_pending_1")).toBe(false);

    const later = await callPost(post(event("SUCCESS")));
    const body = (await later.json()) as Record<string, unknown>;
    expect(body.duplicate).toBeUndefined();
    expect(applyTransactionCreated).toHaveBeenCalledTimes(2);
  });

  it("keeps an ERROR recorded — a failed purchase is final and stays deduped", async () => {
    await callPost(post(event("ERROR", "txn_failed_1")));
    expect(claimedKeys.has("transaction_created:txn_failed_1")).toBe(true);
    expect(eventRows[0]).toMatchObject({ matched: false, error: "transaction_not_successful:ERROR" });

    const again = await callPost(post(event("ERROR", "txn_failed_1")));
    expect(((await again.json()) as Record<string, unknown>).duplicate).toBe(true);
  });
});

describe("the SUCCESS behaviour is unchanged", () => {
  it("still raises the critical alert for a SUCCESSFUL label that matches no order", async () => {
    await callPost(post(event("SUCCESS", "txn_real_1")));

    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shippo_label_unattributed", severity: "critical" }),
    );
  });
});
