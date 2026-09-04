import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE MARKETING WRAPPER OBEYS THE GUARD — for every sender, because every
// sender goes through it.
//
// marketing-frequency-guard.test.ts (under sql/) proves the database claim.
// This pins what sendMarketingEmail does with each answer:
//
//   claimed      send, then close the row the claim wrote (sent/failed + id);
//   deferred     send NOTHING; report it, or park the rendered message in the
//                queue when the caller asked for that;
//   duplicate    send nothing, say so;
//   unavailable  send, and log after the fact exactly as before the guard —
//                a missed marketing email costs nothing next to a lost one;
//   claimedLogId the caller already claimed: no second claim, close that row;
//   alreadyLogged the caller owns its row: no claim, no log.
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "wrapper-test-secret";
});

const state = vi.hoisted(() => ({
  claim: { outcome: "claimed", log_id: "log-1", last_marketing_at: null } as Record<string, unknown> | null,
  rpcError: null as null | { message: string },
  rpcThrows: false,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  sends: [] as Array<{ to: string; subject: string; html: string; text: string; headers?: Record<string, string> }>,
  sendResult: { success: true, providerMessageId: "msg-1" } as { success: boolean; providerMessageId?: string; error?: string },
  logInserts: [] as Array<Record<string, unknown>>,
  logUpdates: [] as Array<{ patch: Record<string, unknown>; id: string }>,
  queueInserts: [] as Array<Record<string, unknown>>,
  /** Rows already parked in marketing_send_queue, as the dedup read sees them. */
  queueRows: [] as Array<Record<string, unknown>>,
  suppressed: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) => {
    state.sends.push({ to: message.to, subject: message.subject, html: message.html, text: message.text, headers: message.headers });
    return state.sendResult;
  }),
}));
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ enabled: true, provider: "resend", from: "Vanta <hello@example.test>", marketingPostalAddress: "1 Test Street, Testville" }),
  resolveMarketingFrom: () => "Vanta <news@mail.example.test>",
  resolveMarketingReplyTo: () => "Vanta <hello@example.test>",
}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
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
          eq: async (_col: string, id: string) => { state.logUpdates.push({ patch, id }); return { error: null }; },
        }),
      };
    }
    if (table === "marketing_send_queue") {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.queueRows, error: null }).then(resolve, reject),
        insert: async (row: Record<string, unknown>) => { state.queueInserts.push(row); return { error: null }; },
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (state.rpcThrows) throw new Error("connection reset");
    state.rpcCalls.push({ fn, args });
    if (state.rpcError) return { data: null, error: state.rpcError };
    return { data: state.claim ? [state.claim] : [], error: null };
  };
  return { supabaseAdmin: { from, rpc } };
});

import { sendMarketingEmail } from "@/lib/email/marketing";

const MESSAGE = {
  to: "Buyer@Example.test",
  campaignType: "back_in_stock",
  referenceId: "bpc-157",
  templateKey: "back_in_stock",
  subject: "Back in stock",
  html: "<html><body><p>It is back.</p></body></html>",
  text: "It is back.",
};

beforeEach(() => {
  state.claim = { outcome: "claimed", log_id: "log-1", last_marketing_at: null };
  state.rpcError = null;
  state.rpcThrows = false;
  state.rpcCalls = [];
  state.sends = [];
  state.sendResult = { success: true, providerMessageId: "msg-1" };
  state.logInserts = [];
  state.logUpdates = [];
  state.queueInserts = [];
  state.queueRows = [];
  state.suppressed = new Set();
});

describe("sendMarketingEmail and the frequency guard", () => {
  it("claims the inbox first, sends, and closes the claim's row with the provider id", async () => {
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.success).toBe(true);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("marketing_send_claim");
    expect(state.rpcCalls[0].args).toMatchObject({
      p_email: "buyer@example.test",
      p_campaign_type: "back_in_stock",
      p_reference_id: "bpc-157",
      p_quiet_seconds: 86_400,
      p_exempt_family: null,
    });
    expect(state.sends).toHaveLength(1);
    expect(state.logInserts).toHaveLength(0);
    expect(state.logUpdates).toEqual([{ id: "log-1", patch: expect.objectContaining({ status: "sent", provider_message_id: "msg-1" }) }]);
  });

  it("closes the claim as failed when the wire refuses, so the inbox is not held shut", async () => {
    state.sendResult = { success: false, error: "provider down" };
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.success).toBe(false);
    expect(state.logUpdates[0].patch).toMatchObject({ status: "failed" });
  });

  it("names the cart-recovery family so a cart's own reminders do not defer each other", async () => {
    await sendMarketingEmail({ ...MESSAGE, campaignType: "cart_recovery_t12h", referenceId: "cart-1" });
    expect(state.rpcCalls[0].args.p_exempt_family).toBe("cart_recovery_");
  });

  it("DEFERRED: sends nothing, logs nothing, and says when to come back", async () => {
    const last = new Date(Date.now() - 2 * 60 * 60 * 1000);
    state.claim = { outcome: "deferred", log_id: null, last_marketing_at: last.toISOString() };
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(result.retryAt).toBe(last.getTime() + 24 * 60 * 60 * 1000);
    expect(state.sends).toHaveLength(0);
    expect(state.logInserts).toHaveLength(0);
    expect(state.logUpdates).toHaveLength(0);
  });

  it("DEFERRED with onDeferred: queue parks the RENDERED message for the sweep", async () => {
    const last = new Date(Date.now() - 60 * 60 * 1000);
    state.claim = { outcome: "deferred", log_id: null, last_marketing_at: last.toISOString() };
    const result = await sendMarketingEmail({ ...MESSAGE, onDeferred: "queue" });
    expect(result.deferred).toBe(true);
    expect(result.queued).toBe(true);
    expect(state.sends).toHaveLength(0);
    expect(state.queueInserts).toHaveLength(1);
    const row = state.queueInserts[0];
    expect(row.recipient_email).toBe("buyer@example.test");
    expect(row.campaign_type).toBe("back_in_stock");
    expect(row.not_before).toBe(new Date(last.getTime() + 24 * 60 * 60 * 1000).toISOString());
    // Rendered in full: the unsubscribe footer and the postal address are baked in.
    expect(String(row.html)).toContain("/api/unsubscribe?email=buyer%40example.test");
    expect(String(row.html)).toContain("1 Test Street, Testville");
    expect(String(row.text_body)).toContain("Unsubscribe:");
  });

  it("DEFERRED with onDeferred: queue parks a message ONCE per recipient, however often the sender asks", async () => {
    state.claim = { outcome: "deferred", log_id: null, last_marketing_at: new Date(Date.now() - 2 * 3_600_000).toISOString() };
    state.queueRows = [{ id: "q-already-parked" }];
    const result = await sendMarketingEmail({ ...MESSAGE, onDeferred: "queue" });
    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.queued).toBe(true);
    expect(state.queueInserts).toHaveLength(0);
    expect(state.sends).toHaveLength(0);
  });

  it("guardUnavailable: the caller already found the guard down — no second claim, logged after the fact", async () => {
    const result = await sendMarketingEmail({ ...MESSAGE, guardUnavailable: true });
    expect(result.success).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.sends).toHaveLength(1);
    expect(state.logInserts).toHaveLength(1);
    expect(state.logUpdates).toHaveLength(0);
  });

  it("a refused address releases the claim the caller was holding, so the row does not sit at 'sending'", async () => {
    state.suppressed.add("buyer@example.test");
    const result = await sendMarketingEmail({ ...MESSAGE, claimedLogId: "log-held" });
    expect(result.suppressed).toBe(true);
    expect(state.sends).toHaveLength(0);
    expect(state.logUpdates).toEqual([{ id: "log-held", patch: { status: "failed" } }]);
  });

  it("DUPLICATE: sends nothing and says so", async () => {
    state.claim = { outcome: "duplicate", log_id: null, last_marketing_at: null };
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.success).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(state.sends).toHaveLength(0);
  });

  it("UNAVAILABLE (un-migrated database): sends and logs after the fact, exactly as before the guard", async () => {
    state.rpcError = { message: "function marketing_send_claim does not exist" };
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.success).toBe(true);
    expect(state.sends).toHaveLength(1);
    expect(state.logUpdates).toHaveLength(0);
    expect(state.logInserts).toEqual([expect.objectContaining({ campaign_type: "back_in_stock", recipient_email: "buyer@example.test", status: "sent", provider_message_id: "msg-1" })]);
  });

  it("UNAVAILABLE (client threw): same fallback, never a throw into the caller", async () => {
    state.rpcThrows = true;
    await expect(sendMarketingEmail(MESSAGE)).resolves.toMatchObject({ success: true });
    expect(state.logInserts).toHaveLength(1);
  });

  it("claimedLogId: the caller already claimed — no second claim, close that row", async () => {
    const result = await sendMarketingEmail({ ...MESSAGE, claimedLogId: "log-cart" });
    expect(result.success).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.logUpdates).toEqual([{ id: "log-cart", patch: expect.objectContaining({ status: "sent" }) }]);
    expect(state.logInserts).toHaveLength(0);
  });

  it("alreadyLogged: the caller owns its row — no claim, no log at all", async () => {
    const result = await sendMarketingEmail({ ...MESSAGE, alreadyLogged: true });
    expect(result.success).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.logUpdates).toHaveLength(0);
    expect(state.logInserts).toHaveLength(0);
  });

  it("an unsubscribed address is refused BEFORE any claim is taken", async () => {
    state.suppressed.add("buyer@example.test");
    const result = await sendMarketingEmail(MESSAGE);
    expect(result.suppressed).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.sends).toHaveLength(0);
  });

  it("a sink address is refused before any claim, too", async () => {
    const result = await sendMarketingEmail({ ...MESSAGE, to: "bounced@resend.dev" });
    expect(result.suppressed).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("still carries the one-click unsubscribe headers on a claimed send", async () => {
    await sendMarketingEmail(MESSAGE);
    expect(state.sends[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(state.sends[0].headers?.["List-Unsubscribe"]).toContain("/api/unsubscribe?email=buyer%40example.test");
  });
});
