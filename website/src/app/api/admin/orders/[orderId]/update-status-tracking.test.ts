import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";
import { applyTransition } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// SHIP-02 — "Save status" with an UNCHANGED status answered 400 after
// half-writing.
//
// Every admin client sends the current status with each save, so entering a
// tracking number, fixing a carrier or setting an ETA asked the pipeline for a
// same-to-same transition, which it refuses ("Order is already …") — AFTER the
// tracking number had already been written. The operator was told it failed;
// orders.tracking_number had changed; order_shipments, the audit log and the
// shipping email had not. Manual (non-Shippo) shipments were un-recordable.
//
// And the notices this route sends carried no provider idempotency key
// (item 11): a timeout-after-accept plus the queued retry duplicated them.
//
// Driven through the real PATCH handler against the shared in-memory database.
// The pipeline writer is reduced to the real transition rules plus the write,
// so an unchanged status is refused exactly as production refuses it.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = "mock";
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.NEXT_PUBLIC_SITE_URL = "https://vantalabsresearch.test";

let db: FakeDb = createFakeDb();

vi.mock("server-only", () => ({}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { void Promise.resolve().then(fn); } };
});
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: () => {},
}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.client; },
  createServerClient: () => db.client,
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => null,
  getSessionAccessToken: async () => null,
}));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ username: "ops", role: "owner" }),
  getRequestIpAddress: () => "203.0.113.9",
  getRequestUserAgent: () => "test-agent",
}));

const sends: Array<{ to: string; subject: string; html: string; idempotencyKey?: string }> = [];
let providerUp = true;
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; html: string; idempotencyKey?: string }) => {
    await Promise.resolve();
    if (!providerUp) return { success: false, error: "Resend API error (503): unavailable" };
    sends.push({ to: message.to, subject: message.subject, html: message.html, idempotencyKey: message.idempotencyKey });
    return { success: true, provider: "resend", providerMessageId: `msg_${sends.length}` };
  },
}));

/** The real transition rules, then the write — a same-to-same request is refused as in production. */
const pipelineCalls: Array<{ orderId: string; to: string }> = [];
vi.mock("@/lib/shippo/service", () => ({
  setOrderFulfillmentStatus: async ({ orderId, to, source, actor }: { orderId: string; to: string; source?: "admin" | "shippo" | "system"; actor?: string | null }) => {
    pipelineCalls.push({ orderId, to });
    const row = db.table("orders").find((o) => o.order_id === orderId);
    if (!row) return { ok: false, code: "not_found", message: "no such order" };
    const transition = applyTransition({ orderId, from: String(row.fulfillment_status), to, source: source ?? "admin", actor: actor ?? null });
    if (!transition.ok) return { ok: false, code: "invalid_request", message: transition.message };
    const from = String(row.fulfillment_status);
    row.fulfillment_status = transition.next;
    return { ok: true, data: { from, to: transition.next } };
  },
}));

const ORDER_ID = "order-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function seedOrder(overrides: Record<string, unknown> = {}) {
  db.seed("orders", [{
    order_id: ORDER_ID,
    order_number: "VL-7100",
    customer_email: "buyer@example.test",
    customer_name: "Casey Buyer",
    payment_status: "paid",
    fulfillment_status: "awaiting_fulfillment",
    tracking_number: null,
    subtotal: 84.98,
    shipping_amount: 8,
    discount_amount: 0,
    tax_amount: 0,
    card_processing_fee: 0,
    amount_paid: 92.98,
    ...overrides,
  }]);
  db.seed("order_items", [{ order_id: ORDER_ID, product_name: "BPC-157 5mg", product_id: "bpc-157", quantity: 2, line_total: 84.98 }]);
}

async function patch(body: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
  const request = new Request(`https://vantalabsresearch.test/api/admin/orders/${ORDER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PATCH(request, { params: Promise.resolve({ orderId: ORDER_ID }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const order = () => db.findOne("orders", "order_id", ORDER_ID) ?? {};

beforeEach(() => {
  db = createFakeDb();
  sends.length = 0;
  pipelineCalls.length = 0;
  providerUp = true;
});

describe("SHIP-02 — the same status with new tracking details is a valid no-op transition", () => {
  it("saves the tracking number, carrier and ETA and answers 200 on an order at awaiting_fulfillment", async () => {
    seedOrder();

    const { status, body } = await patch({
      action: "update_status",
      fulfillmentStatus: "awaiting_fulfillment",
      trackingNumber: "MANUAL-TRK-1",
      carrier: "USPS",
      estimatedDelivery: "2026-09-12",
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(order().tracking_number).toBe("MANUAL-TRK-1");
    expect(order().fulfillment_status).toBe("awaiting_fulfillment");
    // The whole save landed, not half of it.
    const shipments = db.rows("order_shipments");
    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({ order_id: ORDER_ID, carrier: "USPS", tracking_number: "MANUAL-TRK-1", estimated_delivery: "2026-09-12" });
    expect(db.rows("admin_audit_logs")).toHaveLength(1);
    // Nothing was asked of the pipeline: there was no transition to make.
    expect(pipelineCalls).toEqual([]);
    // And no "shipped" email for a parcel that is not yet with the carrier.
    expect(sends).toHaveLength(0);
  });

  it("re-saving a delivered order with a corrected tracking number answers 200 instead of 'Order is already delivered.'", async () => {
    seedOrder({ fulfillment_status: "delivered", tracking_number: "OLD" });

    const { status } = await patch({ action: "update_status", fulfillmentStatus: "delivered", trackingNumber: "CORRECTED", carrier: "UPS" });

    expect(status).toBe(200);
    expect(order().tracking_number).toBe("CORRECTED");
    expect(order().fulfillment_status).toBe("delivered");
    expect(pipelineCalls).toEqual([]);
  });

  it("the legacy spelling of the current status is still recognised as unchanged", async () => {
    seedOrder({ fulfillment_status: "shipped", tracking_number: "1Z1" });

    const { status } = await patch({ action: "update_status", fulfillmentStatus: "Shipped", trackingNumber: "1Z1", carrier: "UPS" });

    expect(status).toBe(200);
    expect(pipelineCalls).toEqual([]);
  });

  it("a REAL status change still goes through the pipeline writer", async () => {
    seedOrder({ fulfillment_status: "packed" });

    const { status } = await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "1Z999AA10123456784", carrier: "UPS" });

    expect(status).toBe(200);
    expect(pipelineCalls).toEqual([{ orderId: ORDER_ID, to: "shipped" }]);
    expect(order().fulfillment_status).toBe("shipped");
  });

  it("a transition the pipeline forbids is refused BEFORE anything is written — no half-applied row", async () => {
    // `delivered` is the carrier's to set, never an admin's.
    seedOrder({ fulfillment_status: "shipped", tracking_number: "1Z1" });

    const { status, body } = await patch({ action: "update_status", fulfillmentStatus: "delivered", trackingNumber: "TAMPERED" });

    expect(status).toBe(400);
    expect(String(body.error)).toContain("can only be set by");
    expect(order().tracking_number).toBe("1Z1");
    expect(db.rows("order_shipments")).toHaveLength(0);
    expect(db.rows("admin_audit_logs")).toHaveLength(0);
    expect(pipelineCalls).toEqual([]);
  });
});

describe("the shipping notices this route sends carry a stable idempotency key", () => {
  it("marking an order shipped sends under order_shipped:<orderId> — the same key the Shippo path uses", async () => {
    seedOrder({ fulfillment_status: "packed" });

    await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "1Z999AA10123456784", carrier: "UPS" });

    expect(sends).toHaveLength(1);
    expect(sends[0].idempotencyKey).toBe(`order_shipped:${ORDER_ID}`);
  });

  it("a tracking-number change on a parcel with the carrier is keyed on the new number, so a later correction is a new email", async () => {
    seedOrder({ fulfillment_status: "shipped", tracking_number: "OLD-TRACKING" });

    await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "NEW-TRACKING", carrier: "UPS" });
    await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "NEWER-TRACKING", carrier: "UPS" });

    expect(sends.map((send) => send.idempotencyKey)).toEqual([
      `order_tracking:NEW-TRACKING:${ORDER_ID}`,
      `order_tracking:NEWER-TRACKING:${ORDER_ID}`,
    ]);
  });

  it("a refused notice is queued with its identity, and the retry sends it under the same key", async () => {
    seedOrder({ fulfillment_status: "packed" });
    providerUp = false;

    const { status } = await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "1Z999AA10123456784", carrier: "UPS" });
    expect(status).toBe(200);

    const queued = db.rows("pending_emails");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ to_email: "buyer@example.test", order_id: ORDER_ID, email_kind: "order_shipped", status: "pending" });

    // The provider comes back and the sweep drains the row: same key on the wire.
    providerUp = true;
    // Live row, not a copy: make it due now.
    db.table("pending_emails")[0].next_attempt_at = new Date(Date.now() - 60_000).toISOString();
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    const drained = await retryPendingEmails();

    expect(drained.sent).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].idempotencyKey).toBe(`order_shipped:${ORDER_ID}`);
  });
});
