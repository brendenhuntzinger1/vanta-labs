import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN AUTOMATION THAT PROMISES A GIFT DOES NOT SEND WITHOUT ONE.
//
// The 60-day win-back's copy says "we'll include a FREE GHK-Cu". The token that
// makes that true is minted per recipient at send time, and it can fail to
// mint — the address is holding a token a checkout is spending right now, or
// the database refused. The sweep used to send anyway, with the ordinary
// button and no token: a promise the checkout could not keep.
//
// Two properties are pinned here, through the real runAutomationSweep:
//
//   * no token -> no send; the slot closes 'failed' so the next sweep retries,
//     and the sweep's error list says why;
//   * the send-once claim is taken BEFORE the mint, so a sweep that loses the
//     claim never mints a token nobody will mail;
//   * a token that IS minted rides the tracked link, and the rendered message
//     carries the gift's real terms.
// ---------------------------------------------------------------------------

const LAPSED = "lapsed@example.test";
const DAY = 24 * 60 * 60 * 1000;
/** Frozen, because the win-back reference id is `${email}:${lastPaidAt}` and two
 *  sweeps must agree on it for the send-once proof below to mean anything. */
const PAID_AT = new Date(Date.now() - 75 * DAY).toISOString();
process.env.UNSUBSCRIBE_SECRET = "automation-offer-gate-test-secret";

const state = vi.hoisted(() => ({
  sendLog: [] as Array<{ reference_id: string; status: string }>,
  sent: [] as Array<{ to: string; html: string; text: string; ctaUrl?: string }>,
  offerResult: null as null | { token: string; expiresAt: string },
  mintCalls: 0,
  /** Order in which the claim and the mint were attempted, for the ordering proof. */
  trace: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: vi.fn(async (input: { to: string; html: string; text: string }) => {
    state.sent.push({ to: input.to, html: input.html, text: input.text });
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
vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    issueCustomerOffer: vi.fn(async () => {
      state.mintCalls += 1;
      state.trace.push("mint");
      return state.offerResult;
    }),
  };
});

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "email_automations") {
      const b: Record<string, unknown> = {
        select: () => b,
        async order() {
          return {
            data: [{
              key: "winback_60",
              enabled: true,
              delay_days: 60,
              subject: "We've got something for you",
              headline: "A FREE GHK-CU ON US!",
              body: "Place your next qualifying order and we'll include a FREE GHK-Cu.",
              promo_code: null,
              cta_label: "CLAIM NOW",
              cta_path: "/products",
              offer_key: "winback_60_free_ghkcu",
              updated_at: new Date().toISOString(),
            }],
            error: null,
          };
        },
      };
      return b;
    }
    if (table === "email_send_log") {
      const b: Record<string, unknown> = {
        _excludeFailed: false,
        select: () => b,
        eq: () => b,
        neq(column: string, value: string) {
          if (column === "status" && value === "failed") (b as { _excludeFailed: boolean })._excludeFailed = true;
          return b;
        },
        async range(from_: number) {
          if (from_ > 0) return { data: [], error: null };
          const rows = (b as { _excludeFailed: boolean })._excludeFailed
            ? state.sendLog.filter((r) => r.status !== "failed")
            : state.sendLog;
          return { data: rows.map((r) => ({ reference_id: r.reference_id })), error: null };
        },
        async insert(row: { reference_id: string; status: string }) {
          state.trace.push("claim");
          if (state.sendLog.some((r) => r.reference_id === row.reference_id && r.status !== "failed")) {
            return { error: { code: "23505", message: "duplicate key" } };
          }
          state.sendLog.push({ reference_id: row.reference_id, status: row.status });
          return { error: null };
        },
        update(patch: { status?: string }) {
          const chain: Record<string, unknown> = {
            eq: (col: string, val: string) => { if (col === "reference_id") (chain as { _ref?: string })._ref = val; return chain; },
            then: (resolve: (v: unknown) => void) => {
              const ref = (chain as { _ref?: string })._ref;
              for (const r of state.sendLog) if (r.reference_id === ref && r.status === "sending" && patch.status) r.status = patch.status;
              resolve({ error: null });
            },
          };
          return chain;
        },
        delete() {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
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
        // One paid order, 75 days ago: past the 60-day threshold.
        async range(from_: number) {
          if (from_ > 0) return { data: [], error: null };
          return {
            data: [{ order_id: "o-1", customer_email: LAPSED, payment_status: "paid", paid_at: PAID_AT, created_at: PAID_AT }],
            error: null,
          };
        },
      };
      return b;
    }
    const noop: Record<string, unknown> = {
      select: () => noop, eq: () => noop, neq: () => noop,
      insert: async () => ({ error: null }),
      async range() { return { data: [], error: null }; },
      async order() { return { data: [], error: null }; },
    };
    return noop;
  };
  return {
    supabaseAdmin: {
      from,
      auth: { admin: { listUsers: async ({ page }: { page: number }) => ({ data: { users: page === 1 ? [{ id: "u1", email: LAPSED, created_at: new Date(Date.now() - 200 * DAY).toISOString() }] : [] }, error: null }) } },
    },
  };
});

const { runAutomationSweep } = await import("@/lib/email/automations");

beforeEach(() => {
  state.sendLog = [];
  state.sent = [];
  state.offerResult = null;
  state.mintCalls = 0;
  state.trace = [];
  vi.clearAllMocks();
});

describe("winback_60 carrying the free GHK-Cu", () => {
  it("does NOT send when no token could be issued, and leaves the recipient eligible for the next sweep", async () => {
    state.offerResult = null;

    const result = await runAutomationSweep();

    expect(state.sent).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.errors.join("\n")).toMatch(/no winback_60_free_ghkcu token/);
    // 'failed' falls outside the send-once index: the next sweep tries again.
    expect(state.sendLog).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("claims the send-once slot BEFORE minting, so a losing sweep never mints a token nobody will mail", async () => {
    state.offerResult = { token: "tok_abc", expiresAt: new Date(Date.now() + 30 * DAY).toISOString() };

    await runAutomationSweep();
    expect(state.trace.indexOf("claim")).toBeLessThan(state.trace.indexOf("mint"));

    // A second sweep finds the slot taken: no mint, no send.
    state.trace = [];
    const before = state.mintCalls;
    const second = await runAutomationSweep();
    expect(second.sent).toBe(0);
    expect(state.mintCalls).toBe(before);
  });

  it("puts the token on the tracked link and the gift's real terms in the message", async () => {
    const expiresAt = new Date(Date.UTC(2026, 9, 4, 12)).toISOString();
    state.offerResult = { token: "tok_abc", expiresAt };

    const result = await runAutomationSweep();

    expect(result.sent).toBe(1);
    const [message] = state.sent;
    expect(message.to).toBe(LAPSED);
    expect(message.html).toMatch(/\/api\/email\/automation-click\?[^"]*o=tok_abc/);
    expect(message.html).toContain("any order of $60 or more");
    expect(message.html).toContain("October 4, 2026");
    expect(message.text).toContain("One per customer");
    expect(state.sendLog).toEqual([expect.objectContaining({ status: "sent" })]);
  });
});
