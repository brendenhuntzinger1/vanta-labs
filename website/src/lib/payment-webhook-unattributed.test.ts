import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPaymentWebhook } from "@/lib/payment-webhook";

const { recordSystemAlert } = vi.hoisted(() => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordSystemAlert,
}));
vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());

// ---------------------------------------------------------------------------
// VL-28 / P9-01. AN EVENT THAT NAMES NO ORDER MUST NOT CREATE ONE.
//
// processPaymentWebhook falls back to a synthetic `order-<uuid>` when neither
// the processor's session id nor any metadata resolves, so the EVENT is still
// recorded under a unique scope. That id identifies nothing.
//
// The order lookup then returned null for it, and the persistence branch
// (`if (!orderRecord || nextStatus !== "paid")`) read that absence as "a brand
// new webhook-created order" — so it INSERTED one: no customer, no email, no
// address, no items, $0, fulfillment_status "pending". It landed in Needs
// Fulfillment looking exactly like a real order nobody could ever fulfil, one
// per unresolvable delivery — and a '*' subscription delivers plenty of those.
// ---------------------------------------------------------------------------

const SECRET = "secret";
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");

const store = () =>
  (globalThis as unknown as {
    __vlSupabaseState: { orders: Map<string, Record<string, unknown>> };
  }).__vlSupabaseState.orders;

/** A real processor event that carries no order reference anywhere. */
const unattributed = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, ...extra });

const alertsOfType = (type: string) =>
  recordSystemAlert.mock.calls
    .map((call) => (call as unknown as [{ type?: string; severity?: string }])[0])
    .filter((alert) => alert?.type === type);

beforeEach(() => {
  store().clear();
  recordSystemAlert.mockClear();
});

describe("a webhook that cannot be attributed to an order", () => {
  it("creates no order row at all", async () => {
    const payload = unattributed("payment.succeeded", { amount: 120 });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-unattributed-1");

    expect([...store().keys()]).toEqual([]);
  });

  it("creates no order row for the unrecognised events a '*' subscription delivers", async () => {
    for (const type of ["payout.paid", "dispute.evidence_required", "something.new"]) {
      const payload = unattributed(type);
      await processPaymentWebhook(payload, sign(payload), SECRET, `evt-noise-${type}`);
    }

    expect(store().size).toBe(0);
  });

  it("does not accumulate one phantom order per delivery", async () => {
    for (let index = 0; index < 5; index += 1) {
      const payload = unattributed("payment.failed");
      await processPaymentWebhook(payload, sign(payload), SECRET, `evt-repeat-${index}`);
    }

    expect(store().size).toBe(0);
  });

  it("tells an operator CRITICALLY when the unattributable event is a real charge", async () => {
    // Not silence: money moved for an order this system cannot name, and the
    // only way it gets matched is a human opening the processor's dashboard.
    const payload = unattributed("payment.succeeded", { amount: 120 });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-unattributed-alert");

    const alerts = alertsOfType("payment_event_unattributed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
  });

  it("does not page anybody for an unattributable event where nothing was charged", async () => {
    const payload = unattributed("payment.failed");
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-unattributed-failed");

    expect(alertsOfType("payment_event_unattributed")[0]?.severity).toBe("warning");
  });

  it("still reports the event as handled rather than throwing", async () => {
    const payload = unattributed("payment.succeeded", { amount: 120 });
    const result = await processPaymentWebhook(payload, sign(payload), SECRET, "evt-unattributed-2");

    expect(result).toMatchObject({ duplicate: false, eventId: "evt-unattributed-2" });
  });
});

describe("an event that DOES name an order is untouched by the guard", () => {
  it("still writes a brand-new order the processor names", async () => {
    const payload = JSON.stringify({
      orderId: "order-named-1",
      type: "payment.failed",
      paymentId: "pay-live",
    });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-named-1");

    // A NAMED order that does not exist yet is still legitimately created —
    // this fix removes the phantom, not the real webhook-created order.
    expect(store().has("order-named-1")).toBe(true);
  });
});
