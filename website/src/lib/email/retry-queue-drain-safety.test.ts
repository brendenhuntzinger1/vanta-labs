import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE TRANSACTIONAL RETRY QUEUE DRAINS SAFELY, AND ITS GIVE-UP IS HEARD.
//
// "Shipping notification not sent; queued for retry" lands a row in
// pending_emails, and the cron sweep's email_retry job drains it. Two things
// about that drain were not true:
//
//   * nothing CLAIMED a row before sending it, so the scheduled sweep and an
//     owner's manual retry landing on the same row together each sent it — and
//     a shipping notice has no idempotency key for the provider to collapse;
//   * when the retry budget ran out the alert was a WARNING, one per row,
//     whose only notifying channel was the very email provider that was down.
//
// The drain now takes a compare-and-set claim on the row it read, refuses a
// row whose send-once slot already reads delivered, and reports give-ups as
// ONE critical that also goes to the phone through the order-push channel.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db = {
  pending_emails: [] as Row[],
  order_email_log: [] as Row[],
};

const alerts: Array<{ type: string; severity: string; message: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string; message: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  },
}));

const pushes: Array<{ title: string; message: string }> = [];
vi.mock("@/lib/order-push-notification", () => ({
  sendOperatorPushNotification: async (message: { title: string; message: string }) => {
    pushes.push(message);
    return true;
  },
}));

const sends: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
/** Resolved by the test, so two drains can be held mid-send and interleaved. */
let releaseSend: (() => void) | null = null;
let providerUp = true;
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; idempotencyKey?: string }) => {
    if (releaseSend === null) {
      // Ordinary path: answer on the next tick.
      await Promise.resolve();
    } else {
      await new Promise<void>((resolve) => { const prior = releaseSend; releaseSend = () => { prior?.(); resolve(); }; });
    }
    if (!providerUp) return { success: false, error: "provider down" };
    sends.push({ to: message.to, subject: message.subject, idempotencyKey: message.idempotencyKey });
    return { success: true, provider: "resend", providerMessageId: `msg_${sends.length}` };
  },
}));

function query(table: keyof typeof db, mode: "select" | "update", patch?: Row) {
  const filters: Array<(row: Row) => boolean> = [];
  let selected = false;
  const run = () => {
    const matched = db[table].filter((row) => filters.every((keep) => keep(row)));
    if (mode === "update") for (const row of matched) Object.assign(row, patch);
    return matched.map((row) => ({ ...row }));
  };
  const builder = {
    eq(column: string, value: unknown) { filters.push((row) => String(row[column] ?? "") === String(value ?? "")); return builder; },
    lte(column: string, value: string) { filters.push((row) => String(row[column] ?? "") <= value); return builder; },
    in(column: string, values: unknown[]) { filters.push((row) => values.map(String).includes(String(row[column]))); return builder; },
    ilike(column: string, pattern: string) {
      const needle = pattern.replace(/%/g, "").toLowerCase();
      filters.push((row) => String(row[column] ?? "").toLowerCase().includes(needle));
      return builder;
    },
    order() { return builder; },
    limit() { return builder; },
    select() { selected = true; return builder; },
    then(resolve: (value: { data: Row[] | null; error: null }) => unknown) {
      // Async on purpose: the interleaving under test needs every database
      // call to yield, exactly as a network round trip does.
      return Promise.resolve().then(() => {
        const rows = run();
        return resolve({ data: mode === "update" && !selected ? [] : rows, error: null });
      });
    },
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: keyof typeof db) {
      return {
        select: () => query(table, "select"),
        update: (patch: Row) => query(table, "update", patch),
        insert: async (row: Row) => { db[table].push({ ...row }); return { error: null }; },
      };
    },
  },
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function queued(overrides: Row = {}): Row {
  return {
    id: `pe-${db.pending_emails.length + 1}`,
    to_email: "buyer@example.test",
    subject: "Shipping Update - VL-3001",
    html: "<p>shipped</p>",
    text_body: "shipped",
    reply_to: null,
    attempts: 1,
    status: "pending",
    next_attempt_at: minutesAgo(1),
    order_id: null,
    email_kind: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.pending_emails = [];
  db.order_email_log = [];
  alerts.length = 0;
  pushes.length = 0;
  sends.length = 0;
  releaseSend = null;
  providerUp = true;
});

describe("two drains on one row", () => {
  it("two overlapping sweeps send a due shipping notice ONCE", async () => {
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued());
    releaseSend = () => {};

    // Both start, both read the row, both try to claim it, then the wire answers.
    const a = retryPendingEmails();
    const b = retryPendingEmails();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    releaseSend();
    const [ra, rb] = await Promise.all([a, b]);

    expect(sends).toHaveLength(1);
    expect(ra.sent + rb.sent).toBe(1);
    expect(db.pending_emails[0].status).toBe("sent");
  });

  it("an owner's manual retry landing on a row the sweep is sending does not send it twice", async () => {
    const { retryPendingEmails, retryPendingEmailsForOrder } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued());
    releaseSend = () => {};

    const sweep = retryPendingEmails();
    const click = retryPendingEmailsForOrder("VL-3001");
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    releaseSend();
    const [swept, clicked] = await Promise.all([sweep, click]);

    expect(sends).toHaveLength(1);
    expect(swept.sent + clicked.sent).toBe(1);
    expect(db.pending_emails[0].status).toBe("sent");
  });

  it("a row nobody else touched is still delivered, with its attempts counted from the start", async () => {
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued({ attempts: 2 }));

    const result = await retryPendingEmails();

    expect(result.sent).toBe(1);
    expect(sends).toHaveLength(1);
    expect(db.pending_emails[0]).toMatchObject({ status: "sent", attempts: 3 });
  });

  it("a row whose send-once slot already reads delivered is settled, not sent again", async () => {
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    db.pending_emails.push(queued({ subject: "Order Confirmed - VL-3001", order_id: "order-3001", email_kind: "order_confirmation" }));
    db.order_email_log.push({ id: 1, order_id: "order-3001", kind: "order_confirmation", status: "sent" });

    const result = await retryPendingEmails();

    expect(result.sent).toBe(0);
    expect(sends).toHaveLength(0);
    expect(db.pending_emails[0].status).toBe("sent");
  });
});

describe("when the retry budget is spent", () => {
  it("raises ONE critical alert for every row given up on, and pushes it to the phone", async () => {
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    providerUp = false;
    db.pending_emails.push(queued({ attempts: 4, subject: "Shipping Update - VL-3001" }));
    db.pending_emails.push(queued({ attempts: 4, subject: "Order Confirmed - VL-3002", to_email: "other@example.test" }));
    // One with budget left: backed off, not given up.
    db.pending_emails.push(queued({ attempts: 1, subject: "Delivered — order VL-3003" }));

    const result = await retryPendingEmails();

    expect(result).toEqual({ sent: 0, retried: 1, gaveUp: 2 });
    expect(db.pending_emails.filter((row) => row.status === "failed")).toHaveLength(2);
    expect(db.pending_emails[2].status).toBe("pending");

    const undeliverable = alerts.filter((a) => a.type === "email_undeliverable");
    expect(undeliverable).toHaveLength(1);
    expect(undeliverable[0].severity).toBe("critical");
    expect(undeliverable[0].message).toContain("Gave up delivering 2 transactional email(s)");
    expect(undeliverable[0].message).toContain("Shipping Update - VL-3001");
    expect(undeliverable[0].message).toContain("Order Confirmed - VL-3002");
    // Masked in the message; the full address stays in context for the operator.
    expect(undeliverable[0].message).not.toContain("buyer@example.test");
    expect(undeliverable[0].message).toContain("b****@example.test");
    expect(undeliverable[0].context?.count).toBe(2);

    // The channel that does not depend on the mail provider.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toBe("Email undeliverable");
    expect(pushes[0].message).toContain("VL-3001");
  });

  it("stays silent on a drain where nothing gave up", async () => {
    const { retryPendingEmails } = await import("@/lib/email/retry-queue");
    providerUp = false;
    db.pending_emails.push(queued({ attempts: 1 }));

    await retryPendingEmails();

    expect(alerts).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });
});
