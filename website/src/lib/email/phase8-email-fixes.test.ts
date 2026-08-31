import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 8 — the five email defects, each with the failure it prevents.
//
// E-03 a claim stranded at 'sending' blocks that order's confirmation for ever
// E-02 the admin manual retry re-sent a receipt the sweep had already delivered
// E-04 refund confirmations were sent outside the send-once guard entirely
// E-01/VL-13 cart-recovery mail carried no CAN-SPAM postal address
// E-08 nothing listened to bounces or spam complaints
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db = {
  order_email_log: [] as Row[],
  pending_emails: [] as Row[],
  email_suppressions: [] as Row[],
};

const alerts: Array<{ type: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  },
}));

const sends: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
const sendResult = { value: { success: true, provider: "resend", providerMessageId: "msg_1" } as { success: boolean; provider?: string; providerMessageId?: string; error?: string } };
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; idempotencyKey?: string }) => {
    sends.push({ to: message.to, subject: message.subject, idempotencyKey: message.idempotencyKey });
    return sendResult.value;
  },
}));

/**
 * A deliberately small stand-in for supabase-js: enough of the filter builder
 * to run these paths, and it throws on anything it does not model rather than
 * silently returning empty — a mock that answers "no rows" to a query it never
 * understood is how a test passes while the code is broken.
 */
function makeQuery(table: keyof typeof db, mode: "select" | "update", patch?: Row) {
  const filters: Array<(row: Row) => boolean> = [];
  let selected = false;

  const builder = {
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    lt(column: string, value: string) {
      filters.push((row) => String(row[column] ?? "") < value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    ilike(column: string, pattern: string) {
      const needle = pattern.replace(/%/g, "").toLowerCase();
      filters.push((row) => String(row[column] ?? "").toLowerCase().includes(needle));
      return builder;
    },
    limit() {
      return builder;
    },
    select() {
      selected = true;
      return builder;
    },
    then(resolve: (value: { data: Row[] | null; error: null }) => unknown) {
      const matched = db[table].filter((row) => filters.every((keep) => keep(row)));
      if (mode === "update") {
        for (const row of matched) Object.assign(row, patch);
      }
      return Promise.resolve(resolve({ data: mode === "update" && !selected ? [] : matched, error: null }));
    },
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: keyof typeof db) {
      return {
        select: () => makeQuery(table, "select"),
        update: (patch: Row) => makeQuery(table, "update", patch),
        upsert: async (row: Row, options: { onConflict: string }) => {
          const key = options.onConflict;
          const existing = db[table].find((candidate) => candidate[key] === row[key]);
          if (existing) Object.assign(existing, row);
          else db[table].push({ ...row });
          return { error: null };
        },
        insert: async (row: Row) => {
          db[table].push({ ...row });
          return { error: null };
        },
      };
    },
  },
}));

beforeEach(() => {
  db.order_email_log = [];
  db.pending_emails = [];
  db.email_suppressions = [];
  alerts.length = 0;
  sends.length = 0;
  sendResult.value = { success: true, provider: "resend", providerMessageId: "msg_1" };
});

// ---------------------------------------------------------------------------
// E-03
// ---------------------------------------------------------------------------
describe("E-03 — a claim stranded at 'sending' is released", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("releases a claim older than the stale window, so the receipt can be sent at all", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    db.order_email_log.push({
      id: 1, order_id: "ord_1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(60),
    });

    const outcome = await reapStrandedOrderEmails();

    expect(outcome.released).toBe(1);
    // 'failed' falls outside the partial unique index — the slot is free again.
    expect(db.order_email_log[0].status).toBe("failed");
    expect(alerts.map((alert) => alert.type)).toContain("order_email_stranded");
  });

  it("leaves a send that is genuinely still in flight alone", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    db.order_email_log.push({
      id: 1, order_id: "ord_1", kind: "order_confirmation", status: "sending", attempted_at: minutesAgo(1),
    });

    expect((await reapStrandedOrderEmails()).released).toBe(0);
    expect(db.order_email_log[0].status).toBe("sending");
  });

  it("never touches a delivered receipt", async () => {
    const { reapStrandedOrderEmails } = await import("@/lib/email/order-email-reaper");
    db.order_email_log.push({
      id: 1, order_id: "ord_1", kind: "order_confirmation", status: "sent", attempted_at: minutesAgo(600),
    });

    expect((await reapStrandedOrderEmails()).released).toBe(0);
    expect(db.order_email_log[0].status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// E-02
// ---------------------------------------------------------------------------
describe("E-02 — the admin manual retry obeys send-once", () => {
  const queued = (overrides: Row = {}) => ({
    id: "pe_1",
    to_email: "buyer@example.com",
    subject: "Your Vanta Labs order VL-1234",
    html: "<p>receipt</p>",
    text_body: "receipt",
    reply_to: null,
    attempts: 3,
    status: "failed",
    order_id: "ord_1",
    email_kind: "order_confirmation",
    ...overrides,
  });

  it("does NOT re-send a receipt the log already records as delivered", async () => {
    const { retryPendingEmailsForOrder } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued());
    db.order_email_log.push({ id: 1, order_id: "ord_1", kind: "order_confirmation", status: "sent" });

    const outcome = await retryPendingEmailsForOrder("VL-1234");

    expect(sends).toHaveLength(0);
    expect(outcome.skippedAlreadySent).toBe(1);
    expect(outcome.sent).toBe(0);
    // The stale queue row is settled, so the panel stops reporting a failure
    // that was made good and a second click finds nothing to do.
    expect(db.pending_emails[0].status).toBe("sent");
  });

  it("still delivers when the slot is genuinely open, with the send-once identity attached", async () => {
    const { retryPendingEmailsForOrder } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued());
    db.order_email_log.push({ id: 1, order_id: "ord_1", kind: "order_confirmation", status: "failed" });

    const outcome = await retryPendingEmailsForOrder("VL-1234");

    expect(outcome.sent).toBe(1);
    expect(sends[0].idempotencyKey).toBe("order_confirmation:ord_1");
    // And the slot it satisfied is closed, so the next caller cannot send a
    // second receipt into the released slot.
    expect(db.order_email_log[0].status).toBe("sent");
  });

  it("still retries a row with no order link — the only recovery an owner has", async () => {
    const { retryPendingEmailsForOrder } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued({ order_id: null, email_kind: null }));

    const outcome = await retryPendingEmailsForOrder("VL-1234");

    expect(outcome.sent).toBe(1);
    expect(sends[0].idempotencyKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E-08
// ---------------------------------------------------------------------------
describe("E-08 — bounces and complaints suppress the address", () => {
  it("reads a Resend permanent bounce as a hard bounce", async () => {
    const { parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    const events = parseDeliveryEvents({
      type: "email.bounced",
      data: { to: ["dead@example.com"], email_id: "re_1", bounce: { type: "Permanent" } },
    });
    expect(events).toEqual([
      { email: "dead@example.com", kind: "hard_bounce", providerMessageId: "re_1", rawType: "email.bounced:permanent" },
    ]);
  });

  it("does NOT suppress a transient Resend bounce — a full mailbox is not a dead address", async () => {
    const { applyDeliveryEvents, parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    const events = parseDeliveryEvents({
      type: "email.bounced",
      data: { to: ["full@example.com"], bounce: { type: "Transient" } },
    });
    expect(events[0].kind).toBe("soft_bounce");
    await applyDeliveryEvents(events);
    expect(db.email_suppressions).toHaveLength(0);
  });

  it("suppresses a Resend complaint and alerts on it", async () => {
    const { applyDeliveryEvents, parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    const outcome = await applyDeliveryEvents(parseDeliveryEvents({
      type: "email.complained",
      data: { to: ["angry@example.com"], email_id: "re_2" },
    }));

    expect(outcome.suppressed).toBe(1);
    expect(db.email_suppressions[0]).toMatchObject({ email: "angry@example.com", reason: "complained" });
    expect(alerts.map((alert) => alert.type)).toContain("email_complaint");
  });

  it("reads SendGrid's array, splitting blocked (soft) from bounced (hard)", async () => {
    const { parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    const events = parseDeliveryEvents([
      { email: "Dead@Example.com", event: "bounce", type: "bounce", sg_message_id: "sg_1" },
      { email: "busy@example.com", event: "bounce", type: "blocked" },
      { email: "angry@example.com", event: "spamreport" },
      { email: "fine@example.com", event: "delivered" },
    ]);
    // "delivered" used to land in `ignored` with everything else the parser did
    // not act on. It is now its own kind — not because anything suppresses on
    // it, but because a delivery is the only event a HEALTHY send produces, and
    // without it an empty event log could not distinguish "nothing bounced"
    // from "the webhook was never configured". See webhook-observability.test.ts.
    expect(events.map((event) => event.kind)).toEqual(["hard_bounce", "soft_bounce", "complaint", "delivered"]);
    // Addresses are normalised, or the suppression would never match a send.
    expect(events[0].email).toBe("dead@example.com");
  });

  it("is idempotent — a redelivered webhook writes one suppression, not two", async () => {
    const { applyDeliveryEvents, parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    const body = [{ email: "dead@example.com", event: "bounce", type: "bounce" }];
    await applyDeliveryEvents(parseDeliveryEvents(body));
    await applyDeliveryEvents(parseDeliveryEvents(body));
    expect(db.email_suppressions).toHaveLength(1);
  });

  it("returns no events for a body it does not recognise, rather than throwing", async () => {
    const { parseDeliveryEvents } = await import("@/lib/email/delivery-events");
    expect(parseDeliveryEvents({ hello: "world" })).toEqual([]);
    expect(parseDeliveryEvents(null)).toEqual([]);
    expect(parseDeliveryEvents("nonsense")).toEqual([]);
  });
});
