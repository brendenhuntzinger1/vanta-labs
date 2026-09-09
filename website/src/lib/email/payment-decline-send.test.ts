import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SENDER. Eligibility is decided in payment-decline-recovery.ts and tested
// there; this is the glue, and the glue is where the production risks are:
//
//   * it runs inside the payment webhook, so it must NEVER throw — a thrown
//     error here would fail a webhook that has already recorded the failure,
//     and the processor would retry the whole envelope.
//   * it re-reads the order rather than trusting what it was handed, so a
//     caller cannot make it mail the wrong person, and so it is safe to call
//     from more than one place.
//   * it sends through sendOrderEmailOnce, whose unique index is what makes a
//     replayed processor event collapse instead of mailing twice.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  order: null as Record<string, unknown> | null,
  sends: [] as Array<{ orderId: string; kind: string; to: string; subject: string; html: string }>,
  sendOutcome: { attempted: true, sent: true } as Record<string, unknown>,
  queued: [] as Array<{ to: string; kind: string; orderId: string }>,
  readError: null as { message: string } | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: store.order, error: store.readError }),
      };
      return b;
    },
  },
}));

vi.mock("@/lib/email/order-email-once", () => ({
  sendOrderEmailOnce: async (input: { orderId: string; kind: string; to: string; template: { subject: string; html: string } }) => {
    store.sends.push({
      orderId: input.orderId, kind: input.kind, to: input.to,
      subject: input.template.subject, html: input.template.html,
    });
    return store.sendOutcome;
  },
}));

vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vantalabsresearch.com" }));

vi.mock("@/lib/email/retry-queue", () => ({
  enqueueFailedEmail: async (message: { to: string }, error: unknown, identity: { orderId: string; kind: string }) => {
    store.queued.push({ to: message.to, kind: identity.kind, orderId: identity.orderId });
  },
}));

const { sendPaymentDeclineRecovery } = await import("@/lib/email/payment-decline-send");

function order(over: Record<string, unknown> = {}) {
  return {
    order_id: "order-1",
    order_number: "VL-1042",
    customer_email: "buyer@x.test",
    customer_name: "Sam",
    amount_paid: 367.94,
    payment_status: "payment_failed",
    payment_failure_kind: "processor_declined",
    order_type: "product",
    ...over,
  };
}

beforeEach(() => {
  store.order = order();
  store.sends = [];
  store.sendOutcome = { attempted: true, sent: true };
  store.queued = [];
  store.readError = null;
});

describe("a declined order is mailed once, correctly", () => {
  it("sends to the address on the order", async () => {
    await sendPaymentDeclineRecovery("order-1");

    expect(store.sends).toHaveLength(1);
    expect(store.sends[0].to).toBe("buyer@x.test");
  });

  it("sends under the payment_declined slot, so a replay collapses", async () => {
    await sendPaymentDeclineRecovery("order-1");
    expect(store.sends[0].kind).toBe("payment_declined");
  });

  it("names the order and amount in the message", async () => {
    await sendPaymentDeclineRecovery("order-1");

    expect(store.sends[0].html).toContain("VL-1042");
    expect(store.sends[0].html).toContain("$367.94");
  });

  // The retry surface is order-scoped: the order UUID is the bearer token, the
  // same pattern the page already documents. It must be absolute — a relative
  // path in an email goes nowhere.
  it("links to this order's own retry page, absolutely", async () => {
    await sendPaymentDeclineRecovery("order-1");
    expect(store.sends[0].html).toContain("https://vantalabsresearch.com/pay/order-1");
  });

  it("carries no discount, so it stays transactional", async () => {
    await sendPaymentDeclineRecovery("order-1");
    const body = store.sends[0].html.toLowerCase();
    expect(body).not.toContain("discount");
    expect(body).not.toContain("% off");
  });
});

describe("it refuses the cases the rule excludes", () => {
  it.each([
    ["an expired checkout", { payment_failure_kind: "checkout_expired" }],
    ["an unexplained failure", { payment_failure_kind: "other" }],
    ["an order that is already paid", { payment_status: "paid" }],
    ["a membership order", { order_type: "membership" }],
    ["an order with no address", { customer_email: null }],
  ])("sends nothing for %s", async (_label, over) => {
    store.order = order(over);

    await sendPaymentDeclineRecovery("order-1");

    expect(store.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEVER THROW. This runs inside the payment webhook. An exception here would
// fail an envelope whose real work — recording the failed payment — has already
// succeeded, and the processor would redeliver the whole thing.
// ---------------------------------------------------------------------------

describe("it cannot break the webhook that calls it", () => {
  it("returns quietly when the order cannot be read", async () => {
    store.readError = { message: "connection reset" };
    store.order = null;

    await expect(sendPaymentDeclineRecovery("order-1")).resolves.not.toThrow();
    expect(store.sends).toHaveLength(0);
  });

  it("returns quietly when the order does not exist", async () => {
    store.order = null;
    await expect(sendPaymentDeclineRecovery("nope")).resolves.not.toThrow();
  });

  it("returns quietly when the send itself fails", async () => {
    store.sendOutcome = { attempted: true, sent: false, error: "provider down" };
    await expect(sendPaymentDeclineRecovery("order-1")).resolves.not.toThrow();
  });

  // FOUND IN THE ADVERSARIAL PASS. The order-confirmation path queues a failed
  // send for the retry sweep; this one only logged, so a transient provider
  // outage meant the highest-value email in the system was simply never sent
  // and nobody would know. The queue carries the same (orderId, kind) identity,
  // which is what lets the sweep close the send-once slot rather than leaving
  // it 'failed' and letting a later caller send a second copy.
  it("queues a failed send for durable retry, under the same identity", async () => {
    store.sendOutcome = { attempted: true, sent: false, error: "provider down" };

    await sendPaymentDeclineRecovery("order-1");

    expect(store.queued).toHaveLength(1);
    expect(store.queued[0]).toMatchObject({ to: "buyer@x.test", kind: "payment_declined", orderId: "order-1" });
  });

  it("queues nothing when the send succeeded", async () => {
    await sendPaymentDeclineRecovery("order-1");
    expect(store.queued).toHaveLength(0);
  });

  it("queues nothing when the email was never attempted", async () => {
    store.sendOutcome = { attempted: false, sent: false, skippedReason: "already_sent" };
    await sendPaymentDeclineRecovery("order-1");
    expect(store.queued).toHaveLength(0);
  });

  it("returns quietly on a blank order id rather than reading the whole table", async () => {
    await expect(sendPaymentDeclineRecovery("")).resolves.not.toThrow();
    expect(store.sends).toHaveLength(0);
  });
});
