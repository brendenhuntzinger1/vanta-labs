import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK E / E-04 — replacement for a mutant nothing could kill.
//
// Mutation testing of the "email dedupe" cluster found that deleting this line
// from loadAlreadySent() in automations.ts left the entire suite green:
//
//     .neq("status", "failed")
//
// The line is deliberate and its comment says why:
//
//     // Only successful sends count as "already sent". A failed attempt must
//     // stay eligible, or one provider hiccup silently drops that recipient
//     // from the sequence permanently.
//
// Without it, a recipient whose welcome or win-back email failed once is treated
// as already-served for ever. They are the customers most in need of the email —
// the ones the system already failed once. Nothing tested it: loadAlreadySent has
// no direct test, and the only suite naming runAutomationSweep
// (src/app/api/cron/sweep/route.test.ts) mocks @/lib/email/automations wholesale,
// so the real function never runs there.
//
// This is the same guard whose ABSENCE in marketing-broadcast.ts is block C's
// finding C-09 — the bug is live in one path and untested in the other.
//
// No real email is sent; sendMarketingEmail is mocked and every call recorded.
// ---------------------------------------------------------------------------

const RECOVERED = "recovered@example.test";  // prior send logged 'failed'
const SERVED = "served@example.test";        // prior send logged 'sent'
const FRESH = "fresh@example.test";          // never emailed

/** Rows in email_send_log for campaign_type 'automation:welcome_no_purchase'. */
let sendLog: Array<{ reference_id: string; status: string }> = [];
/** Everyone sendMarketingEmail was asked to write to. */
const attempted: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: vi.fn(async (input: { to: string }) => {
    attempted.push(input.to);
    return { success: true };
  }),
}));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({
    enabled: true,
    provider: "resend",
    marketingPostalAddress: "1 Test Street, Testville",
  }),
  marketingBlockedReason: () => null,
  resolveMarketingFrom: () => "marketing@example.test",
}));
vi.mock("@/lib/email/audience", () => ({
  loadConsentedAudience: async () => ({
    all: new Set([RECOVERED, SERVED, FRESH]),
    accounts: new Set([RECOVERED, SERVED, FRESH]),
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "email_automations") {
      const b: Record<string, unknown> = {
        select: () => b,
        async order() {
          return {
            data: [{
              key: "welcome_no_purchase",
              enabled: true,
              delay_days: 0,
              subject: "Welcome",
              headline: "Welcome",
              body: "Hello",
              promo_code: null,
              cta_label: "Shop",
              cta_path: "/products",
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
          if (column === "status" && value === "failed") {
            (b as { _excludeFailed: boolean })._excludeFailed = true;
          }
          return b;
        },
        async range(from_: number) {
          if (from_ > 0) return { data: [], error: null };
          const rows = (b as { _excludeFailed: boolean })._excludeFailed
            ? sendLog.filter((r) => r.status !== "failed")
            : sendLog;
          return { data: rows.map((r) => ({ reference_id: r.reference_id })), error: null };
        },
      };
      return b;
    }

    if (table === "orders") {
      const b: Record<string, unknown> = {
        select: () => b,
        async range() { return { data: [], error: null }; },
      };
      return b;
    }

    const noop: Record<string, unknown> = {
      select: () => noop,
      eq: () => noop,
      neq: () => noop,
      insert: async () => ({ error: null }),
      async range() { return { data: [], error: null }; },
      async order() { return { data: [], error: null }; },
    };
    return noop;
  };

  return {
    supabaseAdmin: {
      from,
      auth: {
        admin: {
          listUsers: async ({ page }: { page: number }) => ({
            data: {
              users: page === 1
                ? [RECOVERED, SERVED, FRESH].map((email, i) => ({
                    id: `u${i}`,
                    email,
                    // Well past any delay_days window.
                    created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
                  }))
                : [],
            },
            error: null,
          }),
        },
      },
    },
  };
});

const { runAutomationSweep } = await import("@/lib/email/automations");

beforeEach(() => {
  attempted.length = 0;
  sendLog = [];
  vi.clearAllMocks();
});

describe("a failed automation send leaves the recipient eligible", () => {
  /**
   * THE MUTANT THIS EXISTS TO KILL. Drop `.neq("status", "failed")` from
   * loadAlreadySent and `recovered@` is never written to again.
   */
  it("re-attempts a recipient whose previous send is logged as failed", async () => {
    sendLog = [
      { reference_id: RECOVERED, status: "failed" },
      { reference_id: SERVED, status: "sent" },
    ];

    await runAutomationSweep();

    expect(attempted).toContain(RECOVERED);
  });

  it("does not re-attempt a recipient whose previous send succeeded", async () => {
    sendLog = [
      { reference_id: RECOVERED, status: "failed" },
      { reference_id: SERVED, status: "sent" },
    ];

    await runAutomationSweep();

    expect(attempted).not.toContain(SERVED);
  });

  it("sends to someone who has never been emailed", async () => {
    sendLog = [{ reference_id: SERVED, status: "sent" }];

    await runAutomationSweep();

    expect(attempted).toContain(FRESH);
  });

  /** The whole point, stated as one assertion. */
  it("serves exactly the recipients who have not had a successful send", async () => {
    sendLog = [
      { reference_id: RECOVERED, status: "failed" },
      { reference_id: SERVED, status: "sent" },
    ];

    await runAutomationSweep();

    expect([...attempted].sort()).toEqual([FRESH, RECOVERED].sort());
  });
});
