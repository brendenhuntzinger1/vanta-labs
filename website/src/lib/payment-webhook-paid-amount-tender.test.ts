import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPaymentWebhook } from "@/lib/payment-webhook";

// ---------------------------------------------------------------------------
// TWO THINGS THE CARD LANE'S WEBHOOK DID NOT DO ON A LIVE ENVELOPE.
//
// PAY-02. The paid-amount assertion read only the flat top-level `amount` the
// internal gateway sends. A VeyraGate charge nests its money under
// data.object in minor units, so on every real delivery the assertion compared
// nothing and the order advanced to fulfilment whatever had been captured —
// the harness proved it: amount_cents 1 against a $30.89 order → paid,
// awaiting_fulfillment, no alert.
//
// PAY-08. A decline or cancel released the STOCK hold but not the
// store-credit / points hold, so the shopper's balance read lower by the
// declined order's redemption until the 30-minute sweep, and an immediate
// retry quoted less credit.
//
// Driven through the real handler against the payment-suite fakes.
// ---------------------------------------------------------------------------

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());

const alerts: Array<{ type: string; severity: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  },
}));

const tenderReleases: string[] = [];
vi.mock("@/lib/tender-reservation", () => ({
  releaseOrderTender: async (orderId: string) => {
    tenderReleases.push(orderId);
    return 1;
  },
}));

const SECRET = "secret";
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");

type OrderRow = Record<string, unknown>;
const store = () =>
  (globalThis as unknown as { __vlSupabaseState: { orders: Map<string, OrderRow> } }).__vlSupabaseState.orders;

function seedOrder(orderId: string, overrides: OrderRow = {}) {
  store().set(orderId, {
    id: `row-${orderId}`,
    order_id: orderId,
    payment_status: "pending_payment",
    fulfillment_status: "pending",
    amount_paid: 30.89,
    subtotal: 25,
    customer_email: "dana@example.com",
    ...overrides,
  });
}
const read = (orderId: string) => store().get(orderId) ?? {};

/** A signed VeyraGate-shaped delivery: order id in metadata, money in cents under data.object. */
async function deliver(orderId: string, type: string, charge: Record<string, unknown>, eventId: string) {
  const body = JSON.stringify({ id: eventId, type, data: { object: { metadata: { order_id: orderId }, ...charge } } });
  return processPaymentWebhook(body, sign(body), SECRET, eventId);
}

beforeEach(() => {
  store().clear();
  alerts.length = 0;
  tenderReleases.length = 0;
});

describe("PAY-02 — the paid-amount assertion fires on the live envelope", () => {
  it("a NESTED amount that disagrees is reported (warning, with both figures) but the order is not held — advisory until a live delivery confirms the shape", async () => {
    seedOrder("order-under");
    await deliver("order-under", "charge.succeeded", { amount_cents: 1 }, "evt-under");

    const row = read("order-under");
    expect(row.payment_status).toBe("paid");
    expect(row.fulfillment_status).toBe("awaiting_fulfillment");
    const mismatch = alerts.find((alert) => alert.type === "payment_amount_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.context).toMatchObject({ order_id: "order-under", event_amount: 0.01, recorded_amount: 30.89, held: false, amount_source: "nested" });
  });

  it("a FLAT amount (our own gateway) that disagrees marks the order paid but HOLDS it out of fulfilment, with a critical alert", async () => {
    seedOrder("order-flat");
    const body = JSON.stringify({ id: "evt-flat", type: "payment.succeeded", orderId: "order-flat", amount: 0.01 });
    await processPaymentWebhook(body, sign(body), SECRET, "evt-flat");

    const row = read("order-flat");
    expect(row.payment_status).toBe("paid");
    expect(row.fulfillment_status).toBe("pending");
    const mismatch = alerts.find((alert) => alert.type === "payment_amount_mismatch");
    expect(mismatch?.severity).toBe("critical");
    expect(mismatch?.context).toMatchObject({ order_id: "order-flat", held: true, amount_source: "flat" });
  });

  it("a captured amount that agrees advances the order to fulfilment as before", async () => {
    seedOrder("order-exact");
    await deliver("order-exact", "charge.succeeded", { amount_cents: 3089 }, "evt-exact");

    expect(read("order-exact").payment_status).toBe("paid");
    expect(read("order-exact").fulfillment_status).toBe("awaiting_fulfillment");
    expect(alerts.some((alert) => alert.type === "payment_amount_mismatch")).toBe(false);
  });

  it("a delivery with NO amount is not a mismatch — the reconcile sweep depends on this", async () => {
    seedOrder("order-noamount");
    await deliver("order-noamount", "charge.succeeded", {}, "evt-noamount");

    expect(read("order-noamount").payment_status).toBe("paid");
    expect(read("order-noamount").fulfillment_status).toBe("awaiting_fulfillment");
    expect(alerts.some((alert) => alert.type === "payment_amount_mismatch")).toBe(false);
  });
});

describe("PAY-08 — a decline or cancel hands back the store-credit / points hold", () => {
  it("releases the tender hold on payment_failed", async () => {
    seedOrder("order-declined");
    await deliver("order-declined", "charge.failed", {}, "evt-declined");

    expect(read("order-declined").payment_status).toBe("payment_failed");
    expect(tenderReleases).toEqual(["order-declined"]);
  });

  it("releases the tender hold on a never-captured cancel", async () => {
    seedOrder("order-cancelled");
    await deliver("order-cancelled", "payment.canceled", {}, "evt-cancelled");

    expect(tenderReleases).toEqual(["order-cancelled"]);
  });

  it("does NOT touch the hold on a success — that redemption is now real money spent", async () => {
    seedOrder("order-ok");
    await deliver("order-ok", "charge.succeeded", { amount_cents: 3089 }, "evt-ok");

    expect(tenderReleases).toEqual([]);
  });

  it("does NOT touch the hold on a refund of a paid order", async () => {
    seedOrder("order-refund", { payment_status: "paid", paid_at: new Date().toISOString() });
    await deliver("order-refund", "charge.refunded", {}, "evt-refund");

    expect(tenderReleases).toEqual([]);
  });
});
