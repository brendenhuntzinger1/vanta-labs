import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-04 — RELEASING A STRANDED SLOT IS NOT A RETRY.
//
// A claim stranded at 'sending' means the process died between the claim and
// the enqueue, so pending_emails holds nothing for it, and every caller of
// sendOrderEmailOnce sits behind a once-only claim of its own that will never
// re-enter for that order. The reaper flipped the row to 'failed' and told the
// operator "the sweep's email retry will now pick it up" — and nothing did.
// The customer never got their receipt unless a human read past the
// reassurance and clicked resend.
//
// Now the reaper re-renders the email from the order row and queues it with
// its (order, kind) identity, so the retry sweep delivers it under the SAME
// idempotency key the stranded attempt used and closes the slot it satisfied.
// The alert says which happened.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));

type Row = Record<string, unknown>;

const db = {
  order_email_log: [] as Row[],
  pending_emails: [] as Row[],
  orders: [] as Row[],
  order_items: [] as Row[],
};

const alerts: Array<{ type: string; severity: string; message: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string; message: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  },
}));

const sends: Array<{ to: string; subject: string; text: string; idempotencyKey?: string }> = [];
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string; idempotencyKey?: string }) => {
    sends.push({ to: message.to, subject: message.subject, text: message.text, idempotencyKey: message.idempotencyKey });
    return { success: true, provider: "resend", providerMessageId: `msg_${sends.length}` };
  },
}));

let nextId = 1;

/** Enough of supabase-js to run the reaper and the sweep against these tables. */
function query(table: keyof typeof db, mode: "select" | "update", patch?: Row, columns?: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let selected = false;
  const embeds = [...String(columns ?? "").matchAll(/([a-z_]+)\s*\(/g)].map((m) => m[1]);
  const run = () => {
    const matched = db[table].filter((row) => filters.every((keep) => keep(row)));
    if (mode === "update") for (const row of matched) Object.assign(row, patch);
    return matched.map((row) => {
      const copy: Row = { ...row };
      for (const embed of embeds) {
        copy[embed] = db[embed as keyof typeof db].filter((child) => child.order_id === row.order_id);
      }
      return copy;
    });
  };
  const builder = {
    eq(column: string, value: unknown) { filters.push((row) => String(row[column] ?? "") === String(value ?? "")); return builder; },
    lt(column: string, value: string) { filters.push((row) => String(row[column] ?? "") < value); return builder; },
    lte(column: string, value: string) { filters.push((row) => String(row[column] ?? "") <= value); return builder; },
    in(column: string, values: unknown[]) { filters.push((row) => values.map(String).includes(String(row[column]))); return builder; },
    order() { return builder; },
    limit() { return builder; },
    select() { selected = true; return builder; },
    async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
    then(resolve: (value: { data: Row[] | null; error: null }) => unknown) {
      const rows = run();
      return Promise.resolve(resolve({ data: mode === "update" && !selected ? [] : rows, error: null }));
    },
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: keyof typeof db) {
      return {
        select: (columns?: string) => query(table, "select", undefined, columns),
        update: (patch: Row) => query(table, "update", patch),
        insert: async (row: Row) => {
          db[table].push({ id: nextId++, ...row });
          return { error: null };
        },
      };
    },
  },
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function seedPaidOrder(orderId = "order-1") {
  db.orders.push({
    order_id: orderId,
    order_number: "VL-2001",
    customer_email: "buyer@example.test",
    customer_name: "Casey Buyer",
    subtotal: 84.98,
    shipping_amount: 8,
    discount_amount: 0,
    tax_amount: 0,
    card_processing_fee: 0,
    amount_paid: 92.98,
    payment_status: "paid",
  });
  db.order_items.push({ order_id: orderId, product_name: "BPC-157 5mg", product_id: "bpc-157", quantity: 2, line_total: 84.98 });
}

beforeEach(() => {
  db.order_email_log = [];
  db.pending_emails = [];
  db.orders = [];
  db.order_items = [];
  alerts.length = 0;
  sends.length = 0;
  nextId = 1;
});

describe("a stranded order confirmation is re-queued, not just released", () => {
  it("re-renders the receipt from the order and queues it with its send-once identity", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    seedPaidOrder();
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60) });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome).toEqual({ released: 1, requeued: 1, unrecoverable: 0 });
    expect(db.order_email_log[0].status).toBe("failed");
    expect(db.pending_emails).toHaveLength(1);
    expect(db.pending_emails[0]).toMatchObject({
      to_email: "buyer@example.test",
      status: "pending",
      order_id: "order-1",
      email_kind: "order_confirmation",
    });
    // The customer's own reference and their items, rendered from the row.
    expect(String(db.pending_emails[0].subject)).toContain("VL-2001");
    expect(String(db.pending_emails[0].text_body)).toContain("BPC-157 5mg");
    expect(String(db.pending_emails[0].last_error)).toContain("re-queued by the reaper");
  });

  it("tells the operator the truth: queued for the retry sweep, not a promise the sweep cannot keep", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    seedPaidOrder();
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60) });

    await reapStrandedOrderEmails();

    const alert = alerts.find((a) => a.type === "order_email_stranded");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
    expect(alert!.message).toContain("queued");
    expect(alert!.message).not.toContain("could NOT be re-queued");
    expect(alert!.context?.requeued).toEqual(["order-1:order_confirmation"]);
    expect(alert!.context?.orderIds).toEqual(["order-1"]);
  });

  it("the retry sweep then delivers it under the ORIGINAL idempotency key and closes the slot", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    seedPaidOrder();
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60) });

    await reapStrandedOrderEmails();
    // The queue row is due five minutes out; the sweep after that drains it.
    db.pending_emails[0].next_attempt_at = minutesAgo(1);
    const drained = await retryPendingEmails();

    expect(drained.sent).toBe(1);
    expect(sends).toHaveLength(1);
    // Same identity the stranded attempt used, so a provider that DID accept
    // the original before the process died collapses this as its duplicate.
    expect(sends[0].idempotencyKey).toBe("order_confirmation:order-1");
    expect(sends[0].to).toBe("buyer@example.test");
    // And the record now says the customer has it.
    expect(db.order_email_log[0].status).toBe("sent");
    expect(db.pending_emails[0].status).toBe("sent");
  });

  it("re-renders a stranded refund notice from the amount in its slot", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    seedPaidOrder();
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "refund_confirmation:9298", status: "sending", attempted_at: minutesAgo(60) });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome.requeued).toBe(1);
    expect(db.pending_emails[0]).toMatchObject({ order_id: "order-1", email_kind: "refund_confirmation:9298" });
    const text = String(db.pending_emails[0].text_body).toLowerCase();
    expect(text).toContain("refund");
    expect(text).toContain("92.98");
    expect(text).toContain("full refund");
  });

  it("does not queue a second copy when one is already waiting for this slot", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    seedPaidOrder();
    db.pending_emails.push({ id: nextId++, to_email: "buyer@example.test", subject: "Order Confirmed - VL-2001", status: "pending", order_id: "order-1", email_kind: "order_confirmation", attempts: 1, next_attempt_at: minutesAgo(1) });
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60) });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome.requeued).toBe(1);
    expect(db.pending_emails).toHaveLength(1);
  });
});

describe("a stranded email the reaper cannot rebuild", () => {
  it("is released, and the alert is CRITICAL and says a human must resend it", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    // No order row at all — nothing to render from.
    db.order_email_log.push({ id: nextId++, order_id: "order-gone", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60) });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome).toEqual({ released: 1, requeued: 0, unrecoverable: 1 });
    expect(db.order_email_log[0].status).toBe("failed");
    expect(db.pending_emails).toHaveLength(0);
    const alert = alerts.find((a) => a.type === "order_email_stranded");
    expect(alert!.severity).toBe("critical");
    expect(alert!.message).toContain("resend those by hand");
    expect(alert!.message).not.toMatch(/sweep's email retry will deliver them\. $/);
    expect(alert!.context?.unrecoverable).toEqual(["order-gone:order_confirmation"]);
  });

  it("never claims the sweep will carry a kind it does not know how to render", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    seedPaidOrder();
    db.order_email_log.push({ id: nextId++, order_id: "order-1", kind: "some_future_kind", status: "sending", attempted_at: minutesAgo(60) });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome.unrecoverable).toBe(1);
    expect(db.pending_emails).toHaveLength(0);
    expect(alerts[0].severity).toBe("critical");
  });
});
