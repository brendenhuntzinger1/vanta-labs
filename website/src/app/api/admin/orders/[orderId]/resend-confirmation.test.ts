import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// Two admin-order email defects, driven through the real PATCH handler against
// the shared in-memory database.
//
// EMAIL-10 — "resend confirmation" bypassed send-once, the provider idempotency
// key and order_email_log entirely: the one receipt path with no record, no
// duplicate guard and no retry when the provider refused. It also resent
// "Order Confirmed" for orders that had never been paid.
//
// EMAIL-11 — entering a tracking number on an order still at label_purchased
// emailed "Order … is now: Label purchased", and the first carrier scan then
// sent the real "Shipped" — two notices, the first one wrong.
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
    // Yield once, as a network call does, so two concurrent clicks interleave.
    await Promise.resolve();
    if (!providerUp) return { success: false, error: "Resend API error (503): unavailable" };
    sends.push({ to: message.to, subject: message.subject, html: message.html, idempotencyKey: message.idempotencyKey });
    return { success: true, provider: "resend", providerMessageId: `msg_${sends.length}` };
  },
}));

/** The pipeline writer, reduced to the one move these tests make. */
vi.mock("@/lib/shippo/service", () => ({
  setOrderFulfillmentStatus: async ({ orderId, to }: { orderId: string; to: string }) => {
    const row = db.table("orders").find((o) => o.order_id === orderId);
    if (!row) return { ok: false, code: "not_found", message: "no such order" };
    const from = String(row.fulfillment_status);
    row.fulfillment_status = to;
    return { ok: true, data: { from, to } };
  },
}));

const ORDER_ID = "order-11111111-2222-3333-4444-555555555555";

function seedOrder(overrides: Record<string, unknown> = {}) {
  db.seed("orders", [{
    order_id: ORDER_ID,
    order_number: "VL-7001",
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

const logRows = () => db.rows("order_email_log").map((r) => ({ kind: r.kind, status: r.status }));

beforeEach(() => {
  db = createFakeDb();
  sends.length = 0;
  providerUp = true;
});

describe("resend_confirmation goes through the logged, send-once path", () => {
  it("takes its own numbered slot, sends under a key distinct from the original, and records it", async () => {
    seedOrder();
    // The original receipt, delivered by the webhook lane.
    db.seed("order_email_log", [{ order_id: ORDER_ID, kind: "order_confirmation", status: "sent", attempted_at: "2026-09-01T00:00:00.000Z" }]);

    const { status, body } = await patch({ action: "resend_confirmation" });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe("buyer@example.test");
    expect(sends[0].subject).toContain("VL-7001");
    expect(sends[0].html).toContain("BPC-157 5mg");
    // Deliberately NOT the original's key — this copy is meant to arrive.
    expect(sends[0].idempotencyKey).toBe(`order_confirmation_resend:1:${ORDER_ID}`);
    expect(logRows()).toEqual([
      { kind: "order_confirmation", status: "sent" },
      { kind: "order_confirmation_resend:1", status: "sent" },
    ]);
  });

  it("a later deliberate resend takes the next slot and goes out again", async () => {
    seedOrder();
    await patch({ action: "resend_confirmation" });
    await patch({ action: "resend_confirmation" });

    expect(sends).toHaveLength(2);
    expect(sends[1].idempotencyKey).toBe(`order_confirmation_resend:2:${ORDER_ID}`);
    expect(logRows().map((r) => r.kind)).toEqual(["order_confirmation_resend:1", "order_confirmation_resend:2"]);
  });

  it("two clicks in the same instant collapse onto one slot and one email", async () => {
    seedOrder();

    const [a, b] = await Promise.all([patch({ action: "resend_confirmation" }), patch({ action: "resend_confirmation" })]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(logRows()).toEqual([{ kind: "order_confirmation_resend:1", status: "sent" }]);
  });

  it("queues a refused resend for the retry sweep, with its identity, and says so", async () => {
    seedOrder();
    providerUp = false;

    const { status, body } = await patch({ action: "resend_confirmation" });

    expect(status).toBe(500);
    expect(String(body.error)).toContain("queued");
    expect(logRows()).toEqual([{ kind: "order_confirmation_resend:1", status: "failed" }]);
    const queued = db.rows("pending_emails");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ to_email: "buyer@example.test", order_id: ORDER_ID, email_kind: "order_confirmation_resend:1", status: "pending" });
  });

  it("refuses to resend a receipt for an order that was never paid", async () => {
    seedOrder({ payment_status: "pending_payment" });

    const { status, body } = await patch({ action: "resend_confirmation" });

    expect(status).toBe(400);
    expect(String(body.error)).toContain("not been paid");
    expect(sends).toHaveLength(0);
    expect(db.rows("order_email_log")).toHaveLength(0);
  });
});

describe("a tracking number entered before the parcel ships", () => {
  it("sends nothing while the order is still at label_purchased", async () => {
    seedOrder({ fulfillment_status: "label_purchased" });

    const { status } = await patch({ action: "update_status", trackingNumber: "1Z999AA10123456784", carrier: "UPS" });

    expect(status).toBe(200);
    expect(db.findOne("orders", "order_id", ORDER_ID)?.tracking_number).toBe("1Z999AA10123456784");
    expect(sends).toHaveLength(0);
  });

  it("still tells the customer when the tracking number changes on a parcel already with the carrier", async () => {
    seedOrder({ fulfillment_status: "shipped", tracking_number: "OLD-TRACKING" });

    await patch({ action: "update_status", trackingNumber: "NEW-TRACKING", carrier: "UPS" });

    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toContain("VL-7001");
    expect(sends[0].html).toContain("NEW-TRACKING");
    expect(sends[0].html).not.toContain("Label purchased");
  });

  it("marking the order shipped WITH a tracking number sends exactly one notice, carrying the number", async () => {
    seedOrder({ fulfillment_status: "packed" });

    await patch({ action: "update_status", fulfillmentStatus: "shipped", trackingNumber: "1Z999AA10123456784", carrier: "UPS" });

    expect(sends).toHaveLength(1);
    expect(sends[0].html).toContain("1Z999AA10123456784");
    expect(sends[0].html).toContain("Shipped");
  });
});
