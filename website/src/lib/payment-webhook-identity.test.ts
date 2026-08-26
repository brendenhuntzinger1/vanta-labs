import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPaymentWebhook } from "@/lib/payment-webhook";

// These two fakes used to live in vitest.setup.ts, where they were applied to
// every suite in the repo. They belong to this suite, so this suite asks for them.
vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());


// ---------------------------------------------------------------------------
// A WEBHOOK MUST NEVER ERASE WHO THE CUSTOMER IS.
//
// processPaymentWebhook re-upserts the order row on any NON-paid event. It built
// that upsert from the event payload alone:
//
//   customerEmail: eventPayload.customer?.email     // -> null on a real webhook
//
// A real processor's callback describes a CHARGE, not a shopper — there is no
// top-level `customer` on it. Only our own mock gateway puts one there, and it
// does so by reading these very columns back out of the database, which is
// precisely why nothing caught this: every existing webhook test asserted the
// returned status, and the mock helpfully re-supplied the data being destroyed.
//
// Against a live gateway the fields arrived undefined and the UPDATE wrote NULL
// over a real order's email, name and address. Two routine triggers:
//   - a first-attempt card DECLINE (order is still pending_payment), after which
//     the retry succeeds against an already-wiped row; and
//   - a REFUND or chargeback on a completed order, which loses the record of who
//     bought it permanently.
//
// The damage is silent and expensive: the confirmation email is gated on the
// email, the ambassador commission on ambassador_id, coupon redemption on
// coupon_code, and the Shippo label on the address.
//
// These tests drive the real handler with real (customer-less) payloads and then
// look at the row.
// ---------------------------------------------------------------------------

const SECRET = "secret";
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");

type OrderRow = Record<string, unknown>;
const store = () =>
  (globalThis as unknown as { __vlSupabaseState: { orders: Map<string, OrderRow> } }).__vlSupabaseState.orders;

const IDENTITY: OrderRow = {
  customer_email: "dana@example.com",
  customer_name: "Dana Reyes",
  shipping_address: "88 Meridian Avenue",
  city: "Austin",
  postal_code: "78701",
  referral_code: "DANA10",
  ambassador_id: "amb-1",
  coupon_code: "WELCOME5",
  payment_id: "pay-original",
};

function seedOrder(orderId: string, overrides: OrderRow = {}) {
  store().set(orderId, {
    id: `row-${orderId}`,
    order_id: orderId,
    payment_status: "pending_payment",
    fulfillment_status: "pending",
    amount_paid: 120,
    subtotal: 100,
    ...IDENTITY,
    ...overrides,
  });
}

const read = (orderId: string) => store().get(orderId) ?? {};

// A payload shaped like a real processor's: an event about money, carrying no
// shopper details at all.
const processorEvent = (orderId: string, type: string) =>
  JSON.stringify({ orderId, type, paymentId: "pay-live" });

describe("a declined payment does not erase the customer", () => {
  beforeEach(() => store().clear());

  it("keeps every identity field on the order row", async () => {
    seedOrder("order-declined");
    const payload = processorEvent("order-declined", "payment.failed");
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-decline-1");

    const row = read("order-declined");
    expect(row.payment_status).toBe("payment_failed");
    for (const [column, value] of Object.entries(IDENTITY)) {
      if (column === "payment_id") continue; // the live event legitimately updates this
      expect(row[column], `${column} was wiped`).toBe(value);
    }
  });

  it("still lets the retry succeed against an intact row", async () => {
    seedOrder("order-retry");
    const declined = processorEvent("order-retry", "payment.failed");
    await processPaymentWebhook(declined, sign(declined), SECRET, "evt-retry-1");

    const succeeded = processorEvent("order-retry", "payment.succeeded");
    await processPaymentWebhook(succeeded, sign(succeeded), SECRET, "evt-retry-2");

    const row = read("order-retry");
    expect(row.payment_status).toBe("paid");
    // The confirmation email, the commission and the shipping label all read
    // these three. A wiped row produces a paid order nobody can fulfil.
    expect(row.customer_email).toBe(IDENTITY.customer_email);
    expect(row.ambassador_id).toBe(IDENTITY.ambassador_id);
    expect(row.shipping_address).toBe(IDENTITY.shipping_address);
  });
});

describe("a refund does not erase who bought the order", () => {
  beforeEach(() => store().clear());

  for (const type of ["refund.completed", "charge.refunded", "dispute.created"]) {
    it(`survives ${type}`, async () => {
      seedOrder(`order-${type}`, { payment_status: "paid", paid_at: new Date().toISOString() });
      const payload = processorEvent(`order-${type}`, type);
      await processPaymentWebhook(payload, sign(payload), SECRET, `evt-${type}`);

      const row = read(`order-${type}`);
      expect(row.customer_email).toBe(IDENTITY.customer_email);
      expect(row.customer_name).toBe(IDENTITY.customer_name);
      expect(row.shipping_address).toBe(IDENTITY.shipping_address);
    });
  }
});

describe("an event that DOES carry customer details still wins", () => {
  beforeEach(() => store().clear());

  it("prefers the payload over the stored row", async () => {
    // The fallback must not become a freeze: a gateway that genuinely reports a
    // corrected address should still be able to update it.
    seedOrder("order-updated");
    const payload = JSON.stringify({
      orderId: "order-updated",
      type: "payment.failed",
      customer: { email: "new@example.com", fullName: "New Name", address: "1 New Street", city: "Reno", postalCode: "89501" },
    });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-updated");

    const row = read("order-updated");
    expect(row.customer_email).toBe("new@example.com");
    expect(row.shipping_address).toBe("1 New Street");
  });
});
