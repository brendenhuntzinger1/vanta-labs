import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPaymentWebhook } from "@/lib/payment-webhook";

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());

// ---------------------------------------------------------------------------
// A DECLINE SHOULD SAY WHY.
//
// Until 2026-09-04 a payment.failed webhook wrote `payment_failed` and nothing
// else, so the admin could see THAT a charge failed and never WHY. The
// processor's own words were in the envelope the whole time and were thrown
// away. These tests drive the real handler with a VeyraGate-shaped failure and
// look at the row.
//
// They also pin the two things that must NOT happen: a late decline must never
// demote a paid order (and so must never write a failure reason onto one), and
// a retry that succeeds must still land on `paid`.
// ---------------------------------------------------------------------------

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
    amount_paid: 94.96,
    subtotal: 79.96,
    customer_email: "shopper@example.com",
    customer_name: "A Shopper",
    payment_id: "sess-1",
    ...overrides,
  });
}

const read = (orderId: string) => store().get(orderId) ?? {};

/** A VeyraGate merchant envelope: the order id rides in the charge's metadata. */
const veyraFailure = (orderId: string, charge: Record<string, unknown>) =>
  JSON.stringify({
    id: `evt_${orderId}`,
    type: "payment.failed",
    created_at: "2026-09-04T12:00:00Z",
    data: { object: { ...charge, metadata: { order_id: orderId } } },
  });

describe("a declined charge records the processor's reason", () => {
  beforeEach(() => store().clear());

  it("stores the kind, the decline code and the processor's message", async () => {
    seedOrder("order-declined");
    const payload = veyraFailure("order-declined", {
      failure_code: "card_declined",
      decline_code: "insufficient_funds",
      failure_message: "Your card has insufficient funds.",
    });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-decline-1");

    const row = read("order-declined");
    expect(row.payment_status).toBe("payment_failed");
    expect(row.payment_failure_kind).toBe("processor_declined");
    expect(row.payment_failure_code).toBe("insufficient_funds");
    expect(row.payment_failure_reason).toBe("Your card has insufficient funds.");
    expect(typeof row.payment_failed_at).toBe("string");
  });

  it("still records the kind when the processor gave no reason at all", async () => {
    seedOrder("order-silent");
    const payload = veyraFailure("order-silent", {});
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-silent-1");

    const row = read("order-silent");
    expect(row.payment_status).toBe("payment_failed");
    expect(row.payment_failure_kind).toBe("processor_declined");
    // Not written at all, rather than written as null — see the next test.
    expect(row.payment_failure_code).toBeUndefined();
    expect(row.payment_failure_reason).toBeUndefined();
  });

  it("a later, sparser decline event keeps the richer reason already on the row", async () => {
    // The express lane records Veyra's decline code at authorisation; Veyra then
    // delivers payment.failed for the same session with a bare charge object.
    // The second event must not replace "insufficient_funds" with nothing.
    seedOrder("order-twice", {
      payment_status: "payment_failed",
      payment_failure_kind: "processor_declined",
      payment_failure_code: "insufficient_funds",
      payment_failure_reason: "Insufficient funds",
    });
    const payload = veyraFailure("order-twice", {});
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-twice-1");

    const row = read("order-twice");
    expect(row.payment_status).toBe("payment_failed");
    expect(row.payment_failure_kind).toBe("processor_declined");
    expect(row.payment_failure_code).toBe("insufficient_funds");
    expect(row.payment_failure_reason).toBe("Insufficient funds");
  });

  it("a decline landing on a row the sweep retired as EXPIRED replaces the expired reason, even with none of its own", async () => {
    // Otherwise "The checkout session expired ... No charge was attempted."
    // would sit under a "Declined by bank / processor" badge.
    seedOrder("order-expired-then-declined", {
      payment_status: "payment_failed",
      payment_failure_kind: "checkout_expired",
      payment_failure_code: "expired",
      payment_failure_reason: "The checkout session expired at the processor before a payment was completed. No charge was attempted.",
    });
    const payload = veyraFailure("order-expired-then-declined", {});
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-expired-then-declined");

    const row = read("order-expired-then-declined");
    expect(row.payment_failure_kind).toBe("processor_declined");
    expect(row.payment_failure_code).toBeNull();
    expect(row.payment_failure_reason).toBeNull();
  });

  it("accepts the flat shape the internal mock gateway sends", async () => {
    seedOrder("order-mock");
    const payload = JSON.stringify({ orderId: "order-mock", type: "payment.failed", reason: "Test decline" });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-mock-1");

    const row = read("order-mock");
    expect(row.payment_failure_kind).toBe("processor_declined");
    expect(row.payment_failure_reason).toBe("Test decline");
  });
});

describe("recording a reason never changes what a decline is allowed to do", () => {
  beforeEach(() => store().clear());

  it("a late decline on a PAID order leaves it paid and writes no failure detail", async () => {
    seedOrder("order-paid", { payment_status: "paid", paid_at: "2026-09-04T11:00:00.000Z" });
    const payload = veyraFailure("order-paid", { failure_code: "card_declined", failure_message: "Nope." });
    const result = await processPaymentWebhook(payload, sign(payload), SECRET, "evt-late-1");

    expect(result.status).toBe("paid");
    const row = read("order-paid");
    expect(row.payment_status).toBe("paid");
    expect(row.payment_failure_kind).toBeUndefined();
    expect(row.payment_failure_reason).toBeUndefined();
  });

  // partially_refunded is a captured state too — the shopper's money was taken
  // and only some of it returned. It is deliberately NOT in
  // FULLY_TERMINAL_ORDER_STATES (a later full refund must still reach it), so
  // before the 2026-09-04 pre-merge review a late decline fell through both
  // guards and rewrote such an order as payment_failed.
  it("a late decline on a PARTIALLY REFUNDED order leaves it alone and writes no failure detail", async () => {
    seedOrder("order-partial", {
      payment_status: "partially_refunded",
      paid_at: "2026-09-04T11:00:00.000Z",
      refund_amount: 30,
    });
    const payload = veyraFailure("order-partial", { failure_code: "card_declined", failure_message: "Nope." });
    const result = await processPaymentWebhook(payload, sign(payload), SECRET, "evt-late-partial");

    expect(result.status).toBe("partially_refunded");
    const row = read("order-partial");
    expect(row.payment_status).toBe("partially_refunded");
    expect(row.payment_failure_kind).toBeUndefined();
    expect(row.payment_failure_reason).toBeUndefined();
  });

  it("a FULL refund on a partially refunded order still goes through", async () => {
    // The guard above must not over-reach: refunded is the one legitimate way
    // out of a captured state, and the two-step refund (goods, then shipping)
    // is ordinary practice.
    seedOrder("order-partial-then-full", {
      payment_status: "partially_refunded",
      paid_at: "2026-09-04T11:00:00.000Z",
      refund_amount: 30,
    });
    const payload = JSON.stringify({ orderId: "order-partial-then-full", type: "refund.completed", amount: 64.96 });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-full-after-partial");

    expect(read("order-partial-then-full").payment_status).toBe("refunded");
  });

  it("a successful retry on the same order still lands on paid", async () => {
    seedOrder("order-retry");
    const declined = veyraFailure("order-retry", { failure_code: "card_declined", failure_message: "Declined." });
    await processPaymentWebhook(declined, sign(declined), SECRET, "evt-retry-1");
    expect(read("order-retry").payment_status).toBe("payment_failed");

    const succeeded = JSON.stringify({
      id: "evt_ok",
      type: "payment.succeeded",
      data: { object: { metadata: { order_id: "order-retry" } } },
    });
    await processPaymentWebhook(succeeded, sign(succeeded), SECRET, "evt-retry-2");

    const row = read("order-retry");
    expect(row.payment_status).toBe("paid");
    // The earlier decline stays on the row as history: "first attempt declined,
    // then paid" is true and useful. The UI shows it only as a footnote.
    expect(row.payment_failure_kind).toBe("processor_declined");
  });

  it("a paid event writes no failure detail", async () => {
    seedOrder("order-clean");
    const payload = JSON.stringify({ orderId: "order-clean", type: "payment.succeeded" });
    await processPaymentWebhook(payload, sign(payload), SECRET, "evt-clean-1");

    const row = read("order-clean");
    expect(row.payment_status).toBe("paid");
    expect(row.payment_failure_kind).toBeUndefined();
  });
});
