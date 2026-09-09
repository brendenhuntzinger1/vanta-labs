import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AUTH MAIL HAD NO THREAD BACK TO THE PROVIDER, SO ITS DELIVERY WAS UNKNOWABLE.
//
// Every other send in this system keeps the id the provider assigned:
// order-communications shows it, retry-queue stores it, admin-email joins on
// it, and send-ledger matches `email_send_log` to `email_delivery_events`
// BY THAT COLUMN. The webhook that receives Resend's delivered / opened /
// bounced / complained events carries the same id and nothing else that
// identifies the message.
//
// recordAuthEmailAttempt wrote its row without one. So for signup
// confirmations, password resets and email changes the join had nothing to
// join on, and the delivery events for those messages — the only record of
// whether the mail arrived — could never be attached to the send.
//
// The visible symptom is in production: `auth:signup_confirmation` shows 51
// sends and ZERO opens, across every domain, including the 29 to Gmail whose
// owners demonstrably clicked the link (94% of Gmail signups confirm). Nothing
// was wrong with those emails. There was simply no id to match their events to.
//
// That is what made the 2026-09-08 signup_confirmation_stalled alert
// un-investigable: it says "check whether that provider is rejecting or
// spam-filing our sending domain", and the data needed to answer it was being
// discarded at the moment of the send.
//
// EmailSendResult.providerMessageId already documents itself as "the only
// handle that ties a row in our own logs to a message in the provider's
// dashboard". The provider returns it and the column exists. Only this hop was
// missing.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const log: Row[] = [];
let nextId = 1;

/** Models the partial unique index: one live row per (campaign_type, recipient). */
function liveRow(campaignType: string, email: string): boolean {
  return log.some((r) => r.campaign_type === campaignType && r.recipient_email === email && r.status !== "failed");
}

function chain(patch: Row) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => {
    const matched = log.filter((r) => filters.every(([c, v]) => r[c] === v));
    for (const r of matched) Object.assign(r, patch);
    return matched;
  };
  const b: Record<string, unknown> = {
    eq(c: string, v: unknown) { filters.push([c, v]); return b; },
    async select() { return { data: apply().map((r) => ({ id: r.id })), error: null }; },
    then(resolve: (v: unknown) => unknown) { apply(); return Promise.resolve(resolve({ error: null })); },
  };
  return b;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "email_send_log") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: Row) => {
          if (liveRow(String(row.campaign_type), String(row.recipient_email))) return { error: { code: "23505" } };
          log.push({ id: nextId++, ...row });
          return { error: null };
        },
        update: (patch: Row) => chain(patch),
      };
    },
  },
}));

const { claimAuthEmailSend, recordAuthEmailAttempt } = await import("./auth-email-audit");

beforeEach(() => {
  log.length = 0;
  nextId = 1;
});

describe("auth email keeps the provider's message id", () => {
  it("stores the id on a send that had no claim open", async () => {
    await recordAuthEmailAttempt({
      kind: "signup_confirmation",
      email: "new@example.test",
      success: true,
      providerMessageId: "re_abc123",
    });

    expect(log).toHaveLength(1);
    expect(log[0].provider_message_id).toBe("re_abc123");
  });

  it("stores the id when CLOSING a claim, which is the ordinary path", async () => {
    // claimAuthEmailSend writes the row as 'sending' before the send; the
    // record afterwards updates that same row rather than inserting a second.
    // The id therefore has to land on the UPDATE, or it is lost in every real
    // signup — the branch that matters most and the easy one to miss.
    await claimAuthEmailSend("signup_confirmation", "claimed@example.test");
    await recordAuthEmailAttempt({
      kind: "signup_confirmation",
      email: "claimed@example.test",
      success: true,
      providerMessageId: "re_claimed_999",
    });

    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("sent");
    expect(log[0].provider_message_id).toBe("re_claimed_999");
  });

  it("closes a claim taken under a different key with the id intact", async () => {
    // The signup double-click branch claims as `signup_confirmation` and
    // records as `signup_confirmation_resend` (EMAIL-07). The id must survive
    // that hop too.
    await claimAuthEmailSend("signup_confirmation", "double@example.test");
    await recordAuthEmailAttempt({
      kind: "signup_confirmation_resend",
      email: "double@example.test",
      success: true,
      providerMessageId: "re_resend_42",
      claimedAs: "signup_confirmation",
    });

    expect(log).toHaveLength(1);
    expect(log[0].provider_message_id).toBe("re_resend_42");
  });

  it("writes null rather than inventing an id when the provider gave none", async () => {
    // Absent is a real state — a provider that returns no id, or a send that
    // failed before one existed. It must not become the string "undefined",
    // which would silently poison the join it exists to serve.
    await recordAuthEmailAttempt({
      kind: "password_reset",
      email: "noid@example.test",
      success: true,
    });

    expect(log[0].provider_message_id).toBeNull();
  });

  it("keeps recording the failure reason on a failed send", async () => {
    // The id must not displace what this row already carried: a failed send
    // still reports the provider's reason in reference_id.
    await recordAuthEmailAttempt({
      kind: "signup_confirmation",
      email: "failed@example.test",
      success: false,
      error: "iCloud rejected the message",
    });

    expect(log[0].status).toBe("failed");
    expect(log[0].reference_id).toBe("iCloud rejected the message");
  });
});
