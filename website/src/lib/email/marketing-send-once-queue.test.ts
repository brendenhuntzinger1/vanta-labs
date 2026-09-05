import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-10 — A DEFERRED DUPLICATE IS DROPPED, NOT PARKED FOR TOMORROW.
//
// Membership welcome / win-back, birthday, restock and coupon mail have no
// send-once index. When two sweeps overlapped (or an activation replayed) the
// second copy was not refused: the frequency guard saw the first copy's row
// inside the quiet window and DEFERRED it, and these senders park deferrals,
// so the twin was delivered from the queue a day later. The wrapper now asks
// whether this exact (type, reference, recipient) has already gone before it
// parks anything, and answers `duplicate` when it has.
// ---------------------------------------------------------------------------

vi.hoisted(() => { process.env.UNSUBSCRIBE_SECRET = "send-once-queue-test-secret"; });

const BUYER = "member@example.test";
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

const state = vi.hoisted(() => ({
  sentLog: [] as Array<Record<string, unknown>>,
  queued: [] as Array<Record<string, unknown>>,
  sends: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => { state.sends += 1; return { success: true, providerMessageId: "m1" }; } }));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ enabled: true, provider: "resend", from: "Vanta <hello@example.test>", marketingPostalAddress: "1 Test Street" }),
  marketingBlockedReason: () => null,
  resolveMarketingFrom: () => "Vanta <news@mail.example.test>",
  resolveMarketingReplyTo: () => "Vanta <hello@example.test>",
}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "email_suppressions") {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
      return chain;
    }
    if (table === "email_send_log") {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return b; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
        gte: (c: string, v: unknown) => { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
        limit: () => b,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.sentLog.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve, reject),
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return b;
    }
    if (table === "marketing_send_queue") {
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b, is: () => b, limit: () => b,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
        insert: async (row: Record<string, unknown>) => { state.queued.push(row); return { error: null }; },
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  };
  return {
    supabaseAdmin: {
      from,
      // The guard: a marketing send inside the window stands in the way.
      rpc: async () => ({ data: [{ outcome: "deferred", log_id: null, last_marketing_at: new Date(NOW - 3_600_000).toISOString() }], error: null }),
    },
  };
});

const { sendRenderedMarketingEmail } = await import("@/lib/email/marketing");

const rendered = { to: BUYER, subject: "Welcome to the membership", html: "<html><body>Welcome</body></html>", text: "Welcome" };

beforeEach(() => {
  state.sentLog = [];
  state.queued = [];
  state.sends = 0;
});

describe("a deferred event message that the address already has", () => {
  it("is reported as a duplicate and nothing is queued", async () => {
    // The send that is deferring us IS this message: the other sweep's copy.
    state.sentLog = [{ recipient_email: BUYER, campaign_type: "membership_welcome", reference_id: "user-1", status: "sent", sent_at: new Date(NOW - 3_600_000).toISOString() }];

    const result = await sendRenderedMarketingEmail({
      rendered, campaignType: "membership_welcome", referenceId: "user-1", templateKey: "membershipWelcomeTemplate", onDeferred: "queue",
    });

    expect(result.success).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(state.queued).toHaveLength(0);
    expect(state.sends).toBe(0);
  });

  it("is still parked when the send in the way was a DIFFERENT message", async () => {
    // An ordinary deferral: yesterday's campaign, or a welcome for another
    // reference — this message has never reached the address.
    state.sentLog = [
      { recipient_email: BUYER, campaign_type: "campaign", reference_id: "camp-9", status: "sent", sent_at: new Date(NOW - 3_600_000).toISOString() },
      { recipient_email: BUYER, campaign_type: "membership_welcome", reference_id: "user-other", status: "sent", sent_at: new Date(NOW - 3_600_000).toISOString() },
    ];

    const result = await sendRenderedMarketingEmail({
      rendered, campaignType: "membership_welcome", referenceId: "user-1", templateKey: "membershipWelcomeTemplate", onDeferred: "queue",
    });

    expect(result.deferred).toBe(true);
    expect(result.queued).toBe(true);
    expect(state.queued).toHaveLength(1);
    expect(state.queued[0]).toMatchObject({ campaign_type: "membership_welcome", reference_id: "user-1", recipient_email: BUYER });
  });

  it("a failed earlier attempt is not 'already sent' — the customer never got that one", async () => {
    state.sentLog = [{ recipient_email: BUYER, campaign_type: "membership_welcome", reference_id: "user-1", status: "failed", sent_at: new Date(NOW - 3_600_000).toISOString() }];

    const result = await sendRenderedMarketingEmail({
      rendered, campaignType: "membership_welcome", referenceId: "user-1", templateKey: "membershipWelcomeTemplate", onDeferred: "queue",
    });

    expect(result.queued).toBe(true);
    expect(state.queued).toHaveLength(1);
  });
});
