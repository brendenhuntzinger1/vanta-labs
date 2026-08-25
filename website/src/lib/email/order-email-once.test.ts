import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE ORDER, ONE RECEIPT — AND A RECORD THAT IT HAPPENED.
//
// Two things were missing, and neither showed up as a failing test because
// nothing tested them.
//
// 1. NO RECORD. Order confirmations wrote to no table. After the second real
//    production purchase, "did the customer get their receipt?" was answerable
//    only from absence of evidence: no error in the platform log, no row in
//    pending_emails, email enabled with Resend configured. Correct reasoning,
//    but not a record — it cannot be shown to anyone and it expires with log
//    retention.
//
// 2. NOTHING BUT CONVENTION STOPPED A SECOND SEND. The webhook gates the email
//    behind the atomic paid_side_effects_at claim and that guard works. But it
//    is one caller's discipline. A second code path, or two callers racing
//    through the claim together, would each send.
//
// The ordering is the part worth testing: the slot must be claimed BEFORE the
// provider is called. Claiming afterwards means two callers both send and only
// then discover each other, by which time the customer has two receipts.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type LogRow = {
  id: number;
  order_id: string;
  kind: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  recipient_masked: string | null;
};

const state = {
  rows: [] as LogRow[],
  nextId: 1,
  /** Ordered trace of what happened, so ordering can be asserted directly. */
  trace: [] as string[],
  sendResult: { success: true, provider: "resend", providerMessageId: "msg_abc123" } as {
    success: boolean;
    provider?: string;
    providerMessageId?: string;
    error?: string;
  },
  tableMissing: false,
  lastSendArgs: undefined as { idempotencyKey?: string } | undefined,
};

/** The partial unique index: (order_id, kind) where status in (sending, sent). */
function liveRowExists(orderId: string, kind: string): boolean {
  return state.rows.some(
    (r) => r.order_id === orderId && r.kind === kind && (r.status === "sending" || r.status === "sent"),
  );
}

const sendEmail = vi.fn(async (args: { idempotencyKey?: string }) => {
  state.trace.push("send");
  state.lastSendArgs = args;
  return state.sendResult;
});

vi.mock("@/lib/email/send", () => ({ sendEmail: (args: { idempotencyKey?: string }) => sendEmail(args) }));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table !== "order_email_log") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                async maybeSingle() {
                  if (state.tableMissing) {
                    return { data: null, error: { code: "PGRST205", message: "order_email_log not found in schema cache" } };
                  }
                  state.trace.push("claim");
                  if (liveRowExists(String(row.order_id), String(row.kind))) {
                    return { data: null, error: { code: "23505", message: "duplicate key value" } };
                  }
                  const created: LogRow = {
                    id: state.nextId++,
                    order_id: String(row.order_id),
                    kind: String(row.kind),
                    status: String(row.status),
                    provider: null,
                    provider_message_id: null,
                    error: null,
                    recipient_masked: (row.recipient_masked as string) ?? null,
                  };
                  state.rows.push(created);
                  return { data: { id: created.id }, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_column: string, id: number) {
              state.trace.push(`record:${String(patch.status)}`);
              const row = state.rows.find((r) => r.id === id);
              if (row) {
                row.status = String(patch.status);
                row.provider = (patch.provider as string) ?? null;
                row.provider_message_id = (patch.provider_message_id as string) ?? null;
                row.error = (patch.error as string) ?? null;
              }
              return { data: null, error: null };
            },
          };
        },
      };
    },
  },
}));

const { sendOrderEmailOnce, maskRecipient } = await import("@/lib/email/order-email-once");

const TEMPLATE = { subject: "Your order", html: "<p>hi</p>", text: "hi" };
const ARGS = { orderId: "order-test-1", kind: "order_confirmation" as const, to: "buyer@example.com", template: TEMPLATE };

beforeEach(() => {
  state.rows = [];
  state.nextId = 1;
  state.trace = [];
  state.tableMissing = false;
  state.sendResult = { success: true, provider: "resend", providerMessageId: "msg_abc123" };
  sendEmail.mockClear();
});

describe("send-once", () => {
  it("sends and records the provider's own message id", async () => {
    const outcome = await sendOrderEmailOnce(ARGS);
    expect(outcome).toMatchObject({ attempted: true, sent: true, providerMessageId: "msg_abc123" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      status: "sent",
      provider: "resend",
      provider_message_id: "msg_abc123",
    });
  });

  /**
   * The ordering IS the guarantee. Claim, then send. Reversed, two callers both
   * reach the provider before either learns about the other.
   */
  it("claims the slot BEFORE calling the provider", async () => {
    await sendOrderEmailOnce(ARGS);
    expect(state.trace).toEqual(["claim", "send", "record:sent"]);
    expect(state.trace.indexOf("claim")).toBeLessThan(state.trace.indexOf("send"));
  });

  it("a duplicate webhook does not send a second receipt", async () => {
    await sendOrderEmailOnce(ARGS);
    sendEmail.mockClear();

    const second = await sendOrderEmailOnce(ARGS);
    expect(second).toEqual({ attempted: false, sent: false, skippedReason: "already_sent" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(state.rows.filter((r) => r.status === "sent")).toHaveLength(1);
  });

  it("a caller racing another mid-send is refused too", async () => {
    // Simulate the loser of the race: a 'sending' row already holds the slot.
    state.rows.push({
      id: state.nextId++, order_id: ARGS.orderId, kind: ARGS.kind, status: "sending",
      provider: null, provider_message_id: null, error: null, recipient_masked: "b***@example.com",
    });
    const outcome = await sendOrderEmailOnce(ARGS);
    expect(outcome.skippedReason).toBe("already_sent");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a different KIND of email about the same order is unaffected", async () => {
    await sendOrderEmailOnce(ARGS);
    sendEmail.mockClear();
    const refund = await sendOrderEmailOnce({ ...ARGS, kind: "refund_confirmation" });
    expect(refund.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a different ORDER is unaffected", async () => {
    await sendOrderEmailOnce(ARGS);
    sendEmail.mockClear();
    const other = await sendOrderEmailOnce({ ...ARGS, orderId: "order-test-2" });
    expect(other.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("failure keeps the receipt reachable", () => {
  it("records the failure with the provider's reason and releases the slot", async () => {
    state.sendResult = { success: false, provider: "resend", error: "Resend API error (422): bad address" };
    const first = await sendOrderEmailOnce(ARGS);
    expect(first).toMatchObject({ attempted: true, sent: false });
    expect(state.rows[0]).toMatchObject({ status: "failed", error: "Resend API error (422): bad address" });

    // Released: a genuine retry can still get the receipt out.
    state.sendResult = { success: true, provider: "resend", providerMessageId: "msg_retry" };
    const retry = await sendOrderEmailOnce(ARGS);
    expect(retry.sent).toBe(true);
    // Both attempts survive on the record; the failure is not overwritten.
    expect(state.rows.map((r) => r.status)).toEqual(["failed", "sent"]);
  });
});

describe("the gap our own claim cannot cover", () => {
  /**
   * Claim-then-send stops two callers both sending. It cannot cover the
   * provider accepting a message and this process dying before recording it.
   * A provider-side idempotency key is what closes that, so it must actually
   * be sent — and it must identify the message the same way the claim does.
   */
  it("hands the provider a stable idempotency key for this order and kind", async () => {
    await sendOrderEmailOnce(ARGS);
    expect(state.lastSendArgs?.idempotencyKey).toBe("order_confirmation:order-test-1");
  });

  it("keys a different order and a different kind differently", async () => {
    await sendOrderEmailOnce({ ...ARGS, orderId: "order-test-9" });
    expect(state.lastSendArgs?.idempotencyKey).toBe("order_confirmation:order-test-9");
    await sendOrderEmailOnce({ ...ARGS, kind: "refund_confirmation" });
    expect(state.lastSendArgs?.idempotencyKey).toBe("refund_confirmation:order-test-1");
  });
});

describe("bookkeeping never costs the customer their receipt", () => {
  it("still sends when the log table has not been migrated", async () => {
    state.tableMissing = true;
    const outcome = await sendOrderEmailOnce(ARGS);
    expect(outcome.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(state.rows).toHaveLength(0);
  });
});

describe("what gets stored about the recipient", () => {
  it("stores a masked address, never the address", async () => {
    await sendOrderEmailOnce(ARGS);
    const stored = state.rows[0].recipient_masked ?? "";
    expect(stored).not.toBe("buyer@example.com");
    expect(stored).not.toContain("buyer@");
    // Padded to the local part's length (min 3), matching the mask the
    // confirmation page already shows the customer.
    expect(stored).toBe("b****@example.com");
  });

  it("masks a short local part without revealing its length", () => {
    // Three stars minimum, so 'a@x.com' does not advertise a one-character name.
    expect(maskRecipient("a@x.com")).toBe("a***@x.com");
    expect(maskRecipient("notanemail")).toBe("***");
  });
});
