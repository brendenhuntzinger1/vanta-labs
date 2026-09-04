import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE DEFERRED QUEUE DELIVERS PARKED MAIL — THROUGH THE GUARD, NEVER AROUND IT.
//
// Event mail with no sweep of its own (restock alerts, coupon announcements,
// membership mail) is parked in marketing_send_queue when the frequency guard
// defers it, fully rendered. drainMarketingSendQueue is the cron job that
// delivers it once not_before passes. Pinned here through the REAL drain
// against a fake database and a recorded sendEmail:
//
//   claimed      the STORED subject/html/text go on the wire unchanged, the
//                queue row is marked sent, and the guard's send-log row is
//                closed 'sent' with the provider id;
//   deferred     not_before moves to retryAt, attempts counts one, the row
//                stays queued, and the drain reports deferredAgain;
//   suppressed   unsubscribed since it was parked → cancelled, nothing sent,
//                and the guard is never asked;
//   MAX attempts a row deferred MARKETING_QUEUE_MAX_ATTEMPTS times closes
//                'failed' rather than accumulating for ever;
//   not due      a row whose not_before is still ahead is not touched;
//   no queue     an un-migrated database is one error in the result, not a
//                throw into the sweep.
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "marketing-queue-test-secret";
});

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const BUYER = "buyer@example.test";

const state = vi.hoisted(() => ({
  queue: [] as Array<Record<string, unknown>>,
  /** Set to make the queue read fail as an un-migrated database would. */
  queueUnavailable: false,
  queueUpdates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  claim: { outcome: "claimed", log_id: "log-1", last_marketing_at: null } as Record<string, unknown>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  sends: [] as Array<{ to: string; subject: string; html: string; text: string; headers?: Record<string, string> }>,
  logUpdates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  logInserts: [] as Array<Record<string, unknown>>,
  suppressed: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) => {
    state.sends.push({ to: message.to, subject: message.subject, html: message.html, text: message.text, headers: message.headers });
    return { success: true, providerMessageId: "m1" };
  }),
}));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ enabled: true, provider: "resend", from: "Vanta <hello@example.test>", marketingPostalAddress: "1 Test Street, Testville" }),
  resolveMarketingFrom: () => "Vanta <news@mail.example.test>",
  resolveMarketingReplyTo: () => "Vanta <hello@example.test>",
}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "marketing_send_queue") {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let take = Infinity;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return b; },
        lte: (c: string, v: unknown) => { filters.push((r) => String(r[c] ?? "") <= String(v)); return b; },
        order: () => b,
        limit: (n: number) => { take = n; return b; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (state.queueUnavailable) {
            // Shaped like the client's PostgrestError, which extends Error:
            // the drain's `error instanceof Error` branch is what production
            // takes, so the fake must take it too.
            const error = Object.assign(new Error('relation "marketing_send_queue" does not exist'), { code: "42P01", details: "", hint: "" });
            return Promise.resolve({ data: null, error }).then(resolve, reject);
          }
          const rows = state.queue.filter((r) => filters.every((f) => f(r))).slice(0, take).map((r) => ({ ...r }));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            state.queueUpdates.push({ id, patch });
            const row = state.queue.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return { error: null };
          },
        }),
      };
      return b;
    }
    if (table === "email_suppressions") {
      let email = "";
      const chain = {
        select: () => chain,
        eq: (_col: string, value: string) => { email = value; return chain; },
        maybeSingle: async () => ({ data: state.suppressed.has(email) ? { email } : null, error: null }),
      };
      return chain;
    }
    if (table === "email_send_log") {
      return {
        insert: async (row: Record<string, unknown>) => { state.logInserts.push(row); return { error: null }; },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => { state.logUpdates.push({ id, patch }); return { error: null }; },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    return { data: [state.claim], error: null };
  };
  return { supabaseAdmin: { from, rpc } };
});

const { drainMarketingSendQueue, MARKETING_QUEUE_MAX_ATTEMPTS } = await import("@/lib/email/marketing-queue");

const STORED = {
  subject: "BPC-157 is back in stock",
  html: "<html><body><p>It is back.</p><p>Unsubscribe baked in when it was parked.</p></body></html>",
  text: "It is back.\n\nUnsubscribe: baked in when it was parked.",
};

function seedQueued(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `q-${state.queue.length + 1}`,
    recipient_email: BUYER,
    campaign_type: "back_in_stock",
    reference_id: "bpc-157",
    template_key: "back_in_stock",
    subject: STORED.subject,
    html: STORED.html,
    text_body: STORED.text,
    attempts: 0,
    status: "queued",
    not_before: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  };
  state.queue.push(row);
  return row;
}

beforeEach(() => {
  state.queue = [];
  state.queueUnavailable = false;
  state.queueUpdates = [];
  state.claim = { outcome: "claimed", log_id: "log-1", last_marketing_at: null };
  state.rpcCalls = [];
  state.sends = [];
  state.logUpdates = [];
  state.logInserts = [];
  state.suppressed = new Set();
  vi.clearAllMocks();
});

describe("drainMarketingSendQueue", () => {
  it("CLAIMED: sends the stored message verbatim, marks the row sent, and closes the send-log row", async () => {
    const row = seedQueued();

    const result = await drainMarketingSendQueue({ now: NOW });

    expect(result).toEqual({ sent: 1, deferredAgain: 0, cancelled: 0, failed: 0, errors: [] });

    // The guard is asked for THIS row's identity — a queued message is not a
    // way around the frequency rule.
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("marketing_send_claim");
    expect(state.rpcCalls[0].args).toMatchObject({ p_email: BUYER, p_campaign_type: "back_in_stock", p_reference_id: "bpc-157", p_template_key: "back_in_stock" });

    // What was parked is what goes on the wire: no second footer, no rewrap.
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ to: BUYER, subject: STORED.subject, html: STORED.html, text: STORED.text });
    expect(state.sends[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    expect(state.queueUpdates).toEqual([{ id: row.id, patch: expect.objectContaining({ status: "sent", attempts: 1, last_error: null }) }]);
    expect(row.status).toBe("sent");
    expect(state.logUpdates).toEqual([{ id: "log-1", patch: expect.objectContaining({ status: "sent", provider_message_id: "m1" }) }]);
    expect(state.logInserts).toHaveLength(0);
  });

  it("DEFERRED: pushes not_before to retryAt, counts an attempt, and keeps the row queued", async () => {
    const row = seedQueued();
    const last = new Date(NOW - 20 * HOUR);
    state.claim = { outcome: "deferred", log_id: null, last_marketing_at: last.toISOString() };

    const result = await drainMarketingSendQueue({ now: NOW });

    expect(result).toEqual({ sent: 0, deferredAgain: 1, cancelled: 0, failed: 0, errors: [] });
    expect(state.sends).toHaveLength(0);
    expect(state.queueUpdates).toHaveLength(1);
    const { patch } = state.queueUpdates[0];
    expect(patch.not_before).toBe(new Date(last.getTime() + 24 * HOUR).toISOString());
    expect(patch.attempts).toBe(1);
    expect(patch).not.toHaveProperty("status");
    expect(String(patch.last_error)).toMatch(/deferred/);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(state.logUpdates).toHaveLength(0);
    expect(state.logInserts).toHaveLength(0);
  });

  it("SUPPRESSED since it was parked: cancels the row, sends nothing, never asks the guard", async () => {
    const row = seedQueued();
    state.suppressed.add(BUYER);

    const result = await drainMarketingSendQueue({ now: NOW });

    expect(result).toEqual({ sent: 0, deferredAgain: 0, cancelled: 1, failed: 0, errors: [] });
    expect(state.sends).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.queueUpdates).toEqual([{ id: row.id, patch: expect.objectContaining({ status: "cancelled", attempts: 1 }) }]);
    expect(row.status).toBe("cancelled");
  });

  it(`closes the row failed after ${MARKETING_QUEUE_MAX_ATTEMPTS} deferrals instead of queueing it for ever`, async () => {
    const row = seedQueued();

    // Each drain runs a day after the last, and each time something else has
    // mailed this address an hour earlier — the recipient who is reached by
    // somebody every day.
    for (let attempt = 1; attempt <= MARKETING_QUEUE_MAX_ATTEMPTS; attempt++) {
      const now = NOW + (attempt - 1) * 24 * HOUR;
      state.claim = { outcome: "deferred", log_id: null, last_marketing_at: new Date(now - HOUR).toISOString() };
      const result = await drainMarketingSendQueue({ now });

      if (attempt < MARKETING_QUEUE_MAX_ATTEMPTS) {
        expect(result.deferredAgain, `attempt ${attempt}`).toBe(1);
        expect(result.failed, `attempt ${attempt}`).toBe(0);
        expect(row.status, `attempt ${attempt}`).toBe("queued");
        expect(row.attempts, `attempt ${attempt}`).toBe(attempt);
        expect(row.not_before, `attempt ${attempt}`).toBe(new Date(now - HOUR + 24 * HOUR).toISOString());
      } else {
        expect(result.deferredAgain, `attempt ${attempt}`).toBe(0);
        expect(result.failed, `attempt ${attempt}`).toBe(1);
        expect(row.status, `attempt ${attempt}`).toBe("failed");
        expect(row.attempts, `attempt ${attempt}`).toBe(MARKETING_QUEUE_MAX_ATTEMPTS);
        expect(String(row.last_error)).toMatch(/Deferred/);
      }
    }
    expect(state.sends).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(MARKETING_QUEUE_MAX_ATTEMPTS);

    // Closed means closed: a later drain no longer sees it.
    const after = await drainMarketingSendQueue({ now: NOW + 30 * 24 * HOUR });
    expect(after).toEqual({ sent: 0, deferredAgain: 0, cancelled: 0, failed: 0, errors: [] });
    expect(state.rpcCalls).toHaveLength(MARKETING_QUEUE_MAX_ATTEMPTS);
  });

  it("leaves a row whose not_before is still ahead untouched", async () => {
    const row = seedQueued({ not_before: new Date(NOW + HOUR).toISOString() });

    const result = await drainMarketingSendQueue({ now: NOW });

    expect(result).toEqual({ sent: 0, deferredAgain: 0, cancelled: 0, failed: 0, errors: [] });
    expect(state.queueUpdates).toHaveLength(0);
    expect(state.sends).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
    expect(row).toMatchObject({ status: "queued", attempts: 0 });

    // The same row IS due once the clock reaches it.
    const later = await drainMarketingSendQueue({ now: NOW + HOUR });
    expect(later.sent).toBe(1);
  });

  it("reports an unavailable queue table as one error and does not throw", async () => {
    seedQueued();
    state.queueUnavailable = true;

    const result = await drainMarketingSendQueue({ now: NOW });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^queue read: /);
    expect(result.errors[0]).toContain("marketing_send_queue");
    expect(result).toMatchObject({ sent: 0, deferredAgain: 0, cancelled: 0, failed: 0 });
    expect(state.sends).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.queueUpdates).toHaveLength(0);
  });
});
