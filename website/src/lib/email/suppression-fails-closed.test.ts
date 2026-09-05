import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "IS THIS ADDRESS SUPPRESSED?" MUST NOT BE ANSWERED "NO" BY A DATABASE ERROR.
//
// sendMarketingEmail asked email_suppressions with `const { data } = ...` and
// ignored the error, so a transient read failure looked exactly like "not
// suppressed" and the message went out — to someone who had unsubscribed, or
// whose address had complained or bounced. Marketing mail has a retry queue
// and a next tick; an unsubscribed person mailed anyway has a spam button.
// A marketing send that cannot verify consent does not go.
// ---------------------------------------------------------------------------

process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";

const state = {
  suppressionError: null as { message: string } | null,
  sends: [] as Array<{ to: string }>,
  logInserts: [] as Array<Record<string, unknown>>,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: { to: string }) => { state.sends.push({ to: message.to }); return { success: true }; }),
}));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ enabled: true, provider: "resend", from: "Vanta <hello@example.test>", marketingPostalAddress: "1 Test Street, Testville" }),
  resolveMarketingFrom: () => "Vanta <news@mail.example.test>",
  resolveMarketingReplyTo: () => "Vanta <hello@example.test>",
}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "email_suppressions") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => (state.suppressionError ? { data: null, error: state.suppressionError } : { data: null, error: null }),
      };
      return chain;
    }
    if (table === "email_send_log") {
      return {
        insert: async (row: Record<string, unknown>) => { state.logInserts.push(row); return { error: null }; },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, is: () => b, limit: () => b, order: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

async function send() {
  const { sendMarketingEmail } = await import("@/lib/email/marketing");
  return sendMarketingEmail({
    to: "customer@example.test",
    subject: "A campaign",
    html: "<p>Hello</p>",
    text: "Hello",
    campaignType: "campaign",
    referenceId: "camp-1",
  } as never);
}

beforeEach(() => {
  state.suppressionError = null;
  state.sends = [];
  state.logInserts = [];
});

describe("sendMarketingEmail when the suppression table cannot be read", () => {
  it("refuses to send rather than assuming consent", async () => {
    state.suppressionError = { message: "connection reset" };
    const result = await send();
    expect(result.success).toBe(false);
    expect(state.sends).toHaveLength(0);
    expect(String(result.error ?? "")).toMatch(/suppression|consent|verify/i);
  });

  it("still sends when the read succeeds and the address is clean", async () => {
    const result = await send();
    expect(state.sends).toHaveLength(1);
    expect(result.success).toBe(true);
  });
});
