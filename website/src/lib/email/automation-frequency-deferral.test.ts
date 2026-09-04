import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE AUTOMATION SWEEP OBEYS THE FREQUENCY GUARD.
//
// claimAutomationSend now asks marketing_send_claim (sql/marketing-frequency-
// guard.sql) before it sends anything. The guard's answer decides the sweep's
// behaviour for that recipient, and this file pins each answer through the
// REAL runAutomationSweep against a fake database whose rpc is driven by test
// state:
//
//   deferred     counted in result.deferred, nothing written, nothing sent,
//                and no 'failed' close — the next sweep simply reconsiders;
//   claimed      the guard wrote the row at 'sending'; the sweep sends and
//                closes THAT row 'sent';
//   duplicate    counted as skipped, nothing sent;
//   unavailable  the legacy direct insert takes the send-once slot and the
//                mail still goes out — an un-migrated database must not stop
//                retention mail;
//   quiet        a recipient the in-memory pre-filter already knows was mailed
//                inside the window is never even offered to the guard.
//
// No real email is sent; sendMarketingEmail is mocked and every call recorded.
// ---------------------------------------------------------------------------

const LAPSED = "lapsed@example.test";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Frozen: the win-back reference id is `${email}:${lastPaidAt}`. */
const PAID_AT_MS = Date.now() - 45 * DAY;
const PAID_AT = new Date(PAID_AT_MS).toISOString();
const REFERENCE = `${LAPSED}:${PAID_AT_MS}`;
const CAMPAIGN_TYPE = "automation:winback_30";

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "automation-frequency-deferral-test-secret";
});

type LogRow = Record<string, unknown> & { id: string; status: string };

const state = vi.hoisted(() => ({
  /** What marketing_send_claim answers. */
  claim: "claimed" as "claimed" | "deferred" | "duplicate",
  /** Set to make the rpc fail as an un-migrated database would. */
  rpcError: null as null | { message: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** email_send_log, as the database would hold it. */
  sendLog: [] as LogRow[],
  /** Direct inserts by the sweep — the legacy claim path. */
  logInserts: [] as Array<Record<string, unknown>>,
  /** Every update the sweep made to the log, with its filters. */
  logUpdates: [] as Array<{ patch: Record<string, unknown>; where: Array<[string, unknown]> }>,
  sent: [] as Array<{ to: string; campaignType: string; referenceId: unknown }>,
  nextLogId: 1,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: vi.fn(async (input: { to: string; campaignType: string; referenceId?: unknown }) => {
    state.sent.push({ to: input.to, campaignType: input.campaignType, referenceId: input.referenceId });
    return { success: true, providerMessageId: "msg-1" };
  }),
}));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ enabled: true, provider: "resend", marketingPostalAddress: "1 Test Street, Testville" }),
  marketingBlockedReason: () => null,
  resolveMarketingFrom: () => "marketing@example.test",
}));
vi.mock("@/lib/email/audience", () => ({
  loadConsentedAudience: async () => ({ all: new Set([LAPSED]), accounts: new Set([LAPSED]) }),
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "email_automations") {
      const b: Record<string, unknown> = {
        select: () => b,
        async order() {
          return {
            data: [{
              key: "winback_30",
              enabled: true,
              delay_days: 30,
              subject: "It has been a while",
              headline: "Come back",
              body: "We miss you.",
              promo_code: null,
              cta_label: "SHOP",
              cta_path: "/products",
              offer_key: null,
              updated_at: new Date().toISOString(),
            }],
            error: null,
          };
        },
      };
      return b;
    }

    if (table === "email_send_log") {
      // Filters are honoured, because two different reads share this table:
      // loadAlreadySent (eq campaign_type, neq failed → reference_id) and the
      // quiet-period pre-filter (gte sent_at, neq failed → recipient_email,
      // sent_at, campaign_type). Rows carry every column both reads need.
      const filters: Array<(row: LogRow) => boolean> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq(c: string, v: unknown) { filters.push((r) => String(r[c]) === String(v)); return b; },
        neq(c: string, v: unknown) { filters.push((r) => String(r[c]) !== String(v)); return b; },
        gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
        order: () => b,
        async range(from_: number) {
          if (from_ > 0) return { data: [], error: null };
          return { data: state.sendLog.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
        },
        // The legacy direct claim, under the same partial unique index the
        // database enforces: one live row per (campaign_type, reference_id).
        async insert(row: Record<string, unknown>) {
          state.logInserts.push(row);
          const clash = state.sendLog.some((r) =>
            r.campaign_type === row.campaign_type && r.reference_id === row.reference_id && r.status !== "failed");
          if (clash) return { error: { code: "23505", message: "duplicate key" } };
          state.sendLog.push({ id: `log-${state.nextLogId++}`, ...row } as LogRow);
          return { error: null };
        },
        update(patch: Record<string, unknown>) {
          const where: Array<[string, unknown]> = [];
          const chain: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { where.push([c, v]); return chain; },
            then: (resolve: (v: unknown) => void) => {
              state.logUpdates.push({ patch, where });
              for (const r of state.sendLog) {
                if (where.every(([c, v]) => String(r[c]) === String(v))) Object.assign(r, patch);
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
        delete() {
          const where: Array<[string, unknown]> = [];
          const chain: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { where.push([c, v]); return chain; },
            then: (resolve: (v: unknown) => void) => {
              state.sendLog = state.sendLog.filter((r) => !where.every(([c, v]) => String(r[c]) === String(v)));
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
      return b;
    }

    if (table === "orders") {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        // One paid order, 45 days ago: past the 30-day threshold.
        async range(from_: number) {
          if (from_ > 0) return { data: [], error: null };
          return {
            data: [{ order_id: "o-1", customer_email: LAPSED, payment_status: "paid", created_at: PAID_AT }],
            error: null,
          };
        },
      };
      return b;
    }

    const noop: Record<string, unknown> = {
      select: () => noop, eq: () => noop, neq: () => noop, is: () => noop, gte: () => noop,
      insert: async () => ({ error: null }),
      async range() { return { data: [], error: null }; },
      order: () => noop,
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve); },
    };
    return noop;
  };

  // marketing_send_claim, as the database function behaves: a claim WRITES the
  // send-log row itself at 'sending' and hands back its id; a deferral names
  // the blocking send; a duplicate names nothing.
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (state.rpcError) return { data: null, error: state.rpcError };
    if (state.claim === "deferred") {
      return {
        data: [{ outcome: "deferred", log_id: null, last_marketing_at: new Date(Date.now() - 2 * HOUR).toISOString() }],
        error: null,
      };
    }
    if (state.claim === "duplicate") {
      return { data: [{ outcome: "duplicate", log_id: null, last_marketing_at: null }], error: null };
    }
    const id = `log-${state.nextLogId++}`;
    state.sendLog.push({
      id,
      campaign_type: String(args.p_campaign_type),
      reference_id: String(args.p_reference_id),
      recipient_email: String(args.p_email),
      template_key: String(args.p_template_key),
      status: "sending",
      sent_at: new Date().toISOString(),
    });
    return { data: [{ outcome: "claimed", log_id: id, last_marketing_at: null }], error: null };
  };

  return {
    supabaseAdmin: {
      from,
      rpc,
      auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
    },
  };
});

const { runAutomationSweep } = await import("@/lib/email/automations");
const { sendMarketingEmail } = await import("@/lib/email/marketing");

beforeEach(() => {
  state.claim = "claimed";
  state.rpcError = null;
  state.rpcCalls = [];
  state.sendLog = [];
  state.logInserts = [];
  state.logUpdates = [];
  state.sent = [];
  state.nextLogId = 1;
  vi.clearAllMocks();
});

describe("runAutomationSweep and the frequency guard", () => {
  it("DEFERRED: counts the recipient, writes nothing, sends nothing, closes nothing", async () => {
    state.claim = "deferred";

    const result = await runAutomationSweep();

    expect(result.deferred).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    // The guard was asked exactly once, for this recipient.
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].args).toMatchObject({ p_email: LAPSED, p_campaign_type: CAMPAIGN_TYPE, p_reference_id: REFERENCE });
    // Nothing reached email_send_log: no direct insert, no row, no close.
    expect(state.logInserts).toHaveLength(0);
    expect(state.sendLog).toHaveLength(0);
    expect(state.logUpdates).toHaveLength(0);
  });

  it("CLAIMED: sends once and closes the guard's own row 'sent'", async () => {
    state.claim = "claimed";

    const result = await runAutomationSweep();

    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.byKey).toEqual({ winback_30: 1 });
    expect(state.sent).toEqual([{ to: LAPSED, campaignType: CAMPAIGN_TYPE, referenceId: REFERENCE }]);
    // The guard wrote the row; the sweep did not insert a second one.
    expect(state.logInserts).toHaveLength(0);
    expect(state.sendLog).toEqual([
      expect.objectContaining({ id: "log-1", reference_id: REFERENCE, status: "sent", provider_message_id: "msg-1" }),
    ]);
  });

  it("DUPLICATE: counts the recipient as skipped and sends nothing", async () => {
    state.claim = "duplicate";

    const result = await runAutomationSweep();

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(0);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(state.sendLog).toHaveLength(0);
    expect(state.logUpdates).toHaveLength(0);
  });

  it("UNAVAILABLE (un-migrated database): the legacy direct claim is used and the mail still goes out", async () => {
    state.rpcError = { message: "function marketing_send_claim does not exist" };

    const result = await runAutomationSweep();

    expect(state.rpcCalls).toHaveLength(1);
    // The sweep took the send-once slot itself, exactly as before the guard.
    expect(state.logInserts).toEqual([
      expect.objectContaining({ campaign_type: CAMPAIGN_TYPE, reference_id: REFERENCE, recipient_email: LAPSED, status: "sending" }),
    ]);
    expect(result.sent).toBe(1);
    expect(result.errors).toEqual([]);
    expect(state.sent).toEqual([{ to: LAPSED, campaignType: CAMPAIGN_TYPE, referenceId: REFERENCE }]);
    expect(state.sendLog).toEqual([expect.objectContaining({ reference_id: REFERENCE, status: "sent" })]);
  });

  it("QUIET PRE-FILTER: a recipient mailed inside 24h is not even offered to the guard, and is counted as deferred", async () => {
    state.claim = "claimed";
    state.sendLog = [{
      id: "log-prior",
      campaign_type: "campaign",
      reference_id: "c-1",
      recipient_email: LAPSED,
      status: "sent",
      sent_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    }];

    const result = await runAutomationSweep();

    expect(state.rpcCalls).toHaveLength(0);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    // Held, not lost: the sweep says so, and the next one reconsiders.
    expect(result.deferred).toBe(1);
    expect(result.errors).toEqual([]);
    // Nothing touched the prior row or added to it.
    expect(state.sendLog).toEqual([expect.objectContaining({ id: "log-prior", status: "sent" })]);
  });

  it("QUIET PRE-FILTER: a claim stranded at 'sending' for more than fifteen minutes is a crash, not a send — the recipient is offered to the guard", async () => {
    state.claim = "claimed";
    state.sendLog = [{
      id: "log-stranded",
      campaign_type: "campaign",
      reference_id: "c-1",
      recipient_email: LAPSED,
      status: "sending",
      sent_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    }];
    const result = await runAutomationSweep();
    expect(state.rpcCalls).toHaveLength(1);
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
  });

  it("QUIET PRE-FILTER: a claim at 'sending' from five minutes ago IS pressure — someone is mid-send", async () => {
    state.claim = "claimed";
    state.sendLog = [{
      id: "log-live",
      campaign_type: "campaign",
      reference_id: "c-1",
      recipient_email: LAPSED,
      status: "sending",
      sent_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    }];
    const result = await runAutomationSweep();
    expect(state.rpcCalls).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(1);
  });

  it("QUIET PRE-FILTER (control): a send just outside the window does not hold the recipient back", async () => {
    state.claim = "claimed";
    state.sendLog = [{
      id: "log-prior",
      campaign_type: "campaign",
      reference_id: "c-1",
      recipient_email: LAPSED,
      status: "sent",
      sent_at: new Date(Date.now() - 25 * HOUR).toISOString(),
    }];

    const result = await runAutomationSweep();

    expect(state.rpcCalls).toHaveLength(1);
    expect(result.sent).toBe(1);
    expect(state.sent.map((s) => s.to)).toEqual([LAPSED]);
  });
});
