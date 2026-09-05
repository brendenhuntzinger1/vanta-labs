import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK C / C-02 — the send-once guarantee is one-way.
//
// order-email-once.ts promises that its unique index "makes a duplicate
// impossible regardless of who asks", and explains that a failed send releases
// the slot so "a genuine retry (the pending_emails sweep, or a later webhook)
// can still get the receipt out".
//
// Both halves are true in isolation and wrong together. The sweep
// (retryPendingEmails) calls sendEmail directly: no idempotency key, no order
// id — pending_emails had no order_id column — and it neither reads
// nor writes order_email_log. So when the sweep delivers a receipt, the log row
// stays at status='failed'. 'failed' rows fall OUTSIDE the partial unique index
// `order_email_log_one_live (order_id, kind) where status in ('sending','sent')`,
// so the slot is free, and the next caller — a redelivered webhook, an admin
// approve, either sendOrderEmailOnce site — claims a fresh slot and sends a
// SECOND receipt to a customer who already has one.
//
// This test models order_email_log WITH that partial unique index and walks the
// real sequence. No real email is sent; the provider is a mock that records.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-1";
const CUSTOMER = "customer@example.test";

/** Flip to make the provider fail, exactly like an outage. */
let providerUp = true;

/** Every message the provider accepted — i.e. what lands in the mailbox. */
const delivered: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];

type LogRow = { id: number; order_id: string; kind: string; status: string };
type PendingRow = {
  /** sql/pending-emails-order-link.sql — nullable, so a context-less row is unchanged. */
  order_id?: string | null;
  email_kind?: string | null;
  id: number;
  to_email: string;
  subject: string;
  html: string | null;
  text_body: string | null;
  reply_to: string | null;
  attempts: number;
  status: string;
  next_attempt_at: string;
};

const db = {
  orderEmailLog: [] as LogRow[],
  pendingEmails: [] as PendingRow[],
  nextLogId: 1,
  nextPendingId: 1,
};

/** The partial unique index, modelled: one live row per (order_id, kind). */
function liveSlotTaken(orderId: string, kind: string) {
  return db.orderEmailLog.some(
    (r) => r.order_id === orderId && r.kind === kind && (r.status === "sending" || r.status === "sent"),
  );
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; idempotencyKey?: string }) => {
    if (!providerUp) return { success: false, error: "provider down" };
    delivered.push({ to: message.to, subject: message.subject, idempotencyKey: message.idempotencyKey });
    return { success: true, provider: "mock", providerMessageId: `msg-${delivered.length}` };
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "order_email_log") {
      return {
        insert: (payload: { order_id: string; kind: string; status: string }) => ({
          select: () => ({
            async maybeSingle() {
              if (liveSlotTaken(payload.order_id, payload.kind)) {
                return { data: null, error: { code: "23505", message: "duplicate key" } };
              }
              const row: LogRow = {
                id: db.nextLogId++,
                order_id: payload.order_id,
                kind: payload.kind,
                status: payload.status,
              };
              db.orderEmailLog.push(row);
              return { data: { id: row.id }, error: null };
            },
          }),
        }),
        // Chainable, because the sweep's write-back claims the slot by
        // (order_id, kind, status) rather than by the id it never saw.
        update: (payload: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = [];
          const chain: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return chain;
            },
            then(resolve: (v: unknown) => unknown) {
              for (const row of db.orderEmailLog) {
                const match = filters.every(([c, v]) => (row as unknown as Record<string, unknown>)[c] === v);
                if (match) Object.assign(row, payload);
              }
              return Promise.resolve(resolve({ error: null }));
            },
          };
          return chain;
        },
      };
    }

    if (table === "pending_emails") {
      const builder: Record<string, unknown> = {
        insert: async (payload: Record<string, unknown>) => {
          db.pendingEmails.push({
            id: db.nextPendingId++,
            to_email: String(payload.to_email),
            subject: String(payload.subject),
            html: (payload.html as string) ?? null,
            text_body: (payload.text_body as string) ?? null,
            reply_to: (payload.reply_to as string) ?? null,
            attempts: Number(payload.attempts ?? 1),
            status: String(payload.status ?? "pending"),
            next_attempt_at: new Date(0).toISOString(),
            // sql/pending-emails-order-link.sql. Nullable — a row queued without
            // order context (a shipping notice) still behaves exactly as before.
            order_id: (payload.order_id as string) ?? null,
            email_kind: (payload.email_kind as string) ?? null,
          });
          return { error: null };
        },
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        ilike: () => builder,
        lte: () => builder,
        order: () => builder,
        async limit() {
          return { data: db.pendingEmails.filter((r) => r.status === "pending"), error: null };
        },
        // Chainable and lazy: the sweep now CLAIMS a row before sending it
        // (`.update(hold).eq("id").eq("status").eq("next_attempt_at").select("id")`)
        // and only then marks it sent, so the fake applies every filter it is
        // given and answers with the rows it changed.
        update: (payload: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = [];
          const apply = () => {
            const matched = db.pendingEmails.filter((r) =>
              filters.every(([c, v]) => String((r as unknown as Record<string, unknown>)[c] ?? "") === String(v ?? "")));
            for (const row of matched) Object.assign(row, payload);
            return matched;
          };
          const chain: Record<string, unknown> = {
            eq(column: string, value: unknown) { filters.push([column, value]); return chain; },
            async select() { return { data: apply().map((r) => ({ id: r.id })), error: null }; },
            then(resolve: (v: unknown) => unknown) { apply(); return Promise.resolve(resolve({ error: null })); },
          };
          return chain;
        },
      };
      return builder;
    }

    throw new Error(`unexpected table ${table}`);
  };
  return { supabaseAdmin: { from } };
});

const { sendOrderEmailOnce } = await import("@/lib/email/order-email-once");
const { enqueueFailedEmail, retryPendingEmails } = await import("@/lib/email/retry-queue");

const TEMPLATE = {
  subject: "Order Confirmed - VL-1234",
  html: "<p>Thanks for your order</p>",
  text: "Thanks for your order",
};

/** What the webhook / admin-approve path does, in the order it does it. */
async function attemptConfirmation() {
  const outcome = await sendOrderEmailOnce({
    orderId: ORDER_ID,
    kind: "order_confirmation",
    to: CUSTOMER,
    template: TEMPLATE,
  });
  if (outcome.attempted && !outcome.sent) {
    await enqueueFailedEmail(
      { to: CUSTOMER, ...TEMPLATE },
      outcome.error,
      { orderId: ORDER_ID, kind: "order_confirmation" },
    );
  }
  return outcome;
}

function logStatuses() {
  return db.orderEmailLog
    .filter((r) => r.order_id === ORDER_ID && r.kind === "order_confirmation")
    .map((r) => r.status);
}

beforeEach(() => {
  providerUp = true;
  delivered.length = 0;
  db.orderEmailLog = [];
  db.pendingEmails = [];
  db.nextLogId = 1;
  db.nextPendingId = 1;
  vi.clearAllMocks();
});

describe("the send-once guarantee holds where it is designed to", () => {
  it("refuses a second concurrent send while the first slot is live", async () => {
    await attemptConfirmation();
    const second = await attemptConfirmation();

    expect(second.attempted).toBe(false);
    expect(second.skippedReason).toBe("already_sent");
    expect(delivered).toHaveLength(1);
  });

  it("keys the provider idempotency on the order and kind", async () => {
    await attemptConfirmation();
    expect(delivered[0].idempotencyKey).toBe(`order_confirmation:${ORDER_ID}`);
  });
});

describe("sweep-then-replay: the customer gets two receipts", () => {
  it("leaves order_email_log at 'failed' after the sweep has delivered the receipt", async () => {
    // 1. Provider outage during the webhook. Log row goes 'failed', the payload
    //    is queued.
    providerUp = false;
    await attemptConfirmation();
    expect(logStatuses()).toEqual(["failed"]);
    expect(db.pendingEmails).toHaveLength(1);

    // 2. Provider recovers, the 30-minute cron sweep drains the queue. The
    //    customer now HAS their receipt.
    providerUp = true;
    const result = await retryPendingEmails();
    expect(result.sent).toBe(1);
    expect(delivered).toHaveLength(1);

    // 3. ...and nothing recorded it against the order. This is the defect.
    expect(logStatuses()).toEqual(["sent"]);
  });

  it("sends a SECOND receipt when any later caller claims the released slot", async () => {
    providerUp = false;
    await attemptConfirmation();
    providerUp = true;
    await retryPendingEmails();
    expect(delivered).toHaveLength(1); // the sweep's copy

    // A redelivered webhook, an admin approving the same order, or the second
    // sendOrderEmailOnce call site. The 'failed' row is outside the partial
    // unique index, so there is no 23505 and nothing to consult.
    const replay = await attemptConfirmation();

    // The mailbox now holds two identical "Order Confirmed" messages.
    expect(delivered).toHaveLength(1);
    expect(replay.skippedReason).toBe("already_sent");
  });

  it("the sweep does not tell the provider which order it is re-sending", async () => {
    providerUp = false;
    await attemptConfirmation();
    providerUp = true;
    await retryPendingEmails();

    // Without an idempotency key, a provider that honours one (Resend) cannot
    // collapse the sweep's copy with any other send of the same receipt.
    expect(delivered[0].idempotencyKey).toBe(`order_confirmation:${ORDER_ID}`);
  });

  /**
   * The write-back claims the slot only from 'failed'. If it stomped any status,
   * a sweep landing while another caller holds 'sending' would flip that live
   * claim to 'sent' — the second sender would then finish and write 'sent' too,
   * and the customer would have two receipts with the log insisting on one.
   */
  it("does not overwrite a slot another sender is holding", async () => {
    // A live claim, exactly as sendOrderEmailOnce leaves it mid-flight.
    db.orderEmailLog.push({ id: 99, order_id: ORDER_ID, kind: "order_confirmation", status: "sending" });
    db.pendingEmails.push({
      id: db.nextPendingId++,
      to_email: CUSTOMER,
      subject: TEMPLATE.subject,
      html: TEMPLATE.html,
      text_body: TEMPLATE.text,
      reply_to: null,
      attempts: 1,
      status: "pending",
      next_attempt_at: new Date(0).toISOString(),
      order_id: ORDER_ID,
      email_kind: "order_confirmation",
    });

    await retryPendingEmails();

    expect(db.orderEmailLog.find((r) => r.id === 99)!.status).toBe("sending");
  });
});
