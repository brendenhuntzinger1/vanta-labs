import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-07 — THE SIGNUP DOUBLE-CLICK CLAIM IS CLOSED UNDER THE KEY IT WAS
// TAKEN WITH.
//
// claimAuthEmailSend(kind, email, debounceAs) writes its 'sending' row as
// `auth:${debounceAs}`. recordAuthEmailAttempt closed rows by `auth:${kind}`.
// The signup route's existing-address branch claims as `signup_confirmation`
// and records as `signup_confirmation_resend`, so every one of those rows —
// four in the harness database, one per double-clicked signup — stayed at
// 'sending' for ever: a send perpetually "in flight", holding the minute's
// slot shut against a genuine retry, and a second row inserted beside it.
//
// The same mismatch left the slot held when the magic link failed to MINT,
// which sends nothing and used to give nothing back.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;
const log: Row[] = [];
let nextId = 1;

/** email_send_log with the once-per-minute partial unique index modelled. */
function liveRow(campaignType: string, email: string): boolean {
  return log.some((r) => r.campaign_type === campaignType && r.recipient_email === email && r.status !== "failed");
}

function chain(mode: "update" | "delete", patch?: Row) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => {
    const matched = log.filter((r) => filters.every(([c, v]) => r[c] === v));
    if (mode === "update") for (const r of matched) Object.assign(r, patch);
    if (mode === "delete") for (const r of matched) log.splice(log.indexOf(r), 1);
    return matched;
  };
  const b: Record<string, unknown> = {
    eq(c: string, v: unknown) { filters.push([c, v]); return b; },
    async select() { return { data: apply().map((r) => ({ id: r.id })), error: null }; },
    then(resolve: (v: unknown) => unknown) { apply(); return Promise.resolve(resolve({ error: null })); },
  };
  return b;
}

const sendResult = { value: { success: true } as { success: boolean; error?: string } };
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => sendResult.value }));

let mintFails = false;
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
        update: (patch: Row) => chain("update", patch),
        delete: () => chain("delete"),
      };
    },
    rpc: async () => ({ data: "user-1", error: null }),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { id: "user-1", email: "new@example.test", email_confirmed_at: null, user_metadata: { full_name: "New Person" } } }, error: null }),
        generateLink: async () => mintFails
          ? { data: null, error: { message: "rate limit" } }
          : { data: { properties: { action_link: "https://p.supabase.co/auth/v1/verify?token=h&type=magiclink", hashed_token: "h", verification_type: "magiclink" } }, error: null },
      },
    },
  },
}));

const EMAIL = "new@example.test";

beforeEach(() => {
  log.length = 0;
  nextId = 1;
  sendResult.value = { success: true };
  mintFails = false;
});

describe("recordAuthEmailAttempt", () => {
  it("closes a claim taken under a different debounce key, instead of leaving it at 'sending' and inserting beside it", async () => {
    const { claimAuthEmailSend, recordAuthEmailAttempt } = await import("@/lib/auth-email-audit");
    expect(await claimAuthEmailSend("signup_confirmation_resend", EMAIL, "signup_confirmation")).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ campaign_type: "auth:signup_confirmation", template_key: "signup_confirmation_resend", status: "sending" });

    await recordAuthEmailAttempt({ kind: "signup_confirmation_resend", email: EMAIL, success: true, claimedAs: "signup_confirmation" });

    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("sent");
  });

  it("without claimedAs still closes a claim taken under the kind itself", async () => {
    const { claimAuthEmailSend, recordAuthEmailAttempt } = await import("@/lib/auth-email-audit");
    await claimAuthEmailSend("password_reset", EMAIL);
    await recordAuthEmailAttempt({ kind: "password_reset", email: EMAIL, success: false, error: "provider down" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "failed", reference_id: "provider down" });
  });
});

describe("sendBrandedConfirmationResend on the signup double-click path", () => {
  it("leaves exactly one row, closed 'sent', under the debounce key", async () => {
    const { sendBrandedConfirmationResend } = await import("@/lib/auth-confirmation-email");

    await sendBrandedConfirmationResend(EMAIL, "https://www.vantalabsresearch.com/account/login?verified=1", "signup_confirmation");

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ campaign_type: "auth:signup_confirmation", status: "sent" });
    expect(log.some((r) => r.status === "sending")).toBe(false);
  });

  it("closes the claim 'failed' when the provider refuses, so the customer can ask again at once", async () => {
    const { sendBrandedConfirmationResend } = await import("@/lib/auth-confirmation-email");
    sendResult.value = { success: false, error: "provider down" };

    await sendBrandedConfirmationResend(EMAIL, "https://www.vantalabsresearch.com/account/login?verified=1", "signup_confirmation");

    const claim = log.find((r) => r.campaign_type === "auth:signup_confirmation");
    expect(claim?.status).toBe("failed");
    expect(log.some((r) => r.status === "sending")).toBe(false);
  });

  it("gives the slot back when the magic link cannot be minted — nothing was sent", async () => {
    const { sendBrandedConfirmationResend } = await import("@/lib/auth-confirmation-email");
    mintFails = true;

    await sendBrandedConfirmationResend(EMAIL, "https://www.vantalabsresearch.com/account/login?verified=1", "signup_confirmation");

    expect(log.some((r) => r.status === "sending")).toBe(false);
    // And a retry inside the same minute is not refused by a phantom send.
    const { claimAuthEmailSend } = await import("@/lib/auth-email-audit");
    expect(await claimAuthEmailSend("signup_confirmation_resend", EMAIL, "signup_confirmation")).toBe(true);
  });

  it("with no debounce key (the resend button) claims and closes under its own kind", async () => {
    const { sendBrandedConfirmationResend } = await import("@/lib/auth-confirmation-email");

    await sendBrandedConfirmationResend(EMAIL, "https://www.vantalabsresearch.com/account/login?verified=1");

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ campaign_type: "auth:signup_confirmation_resend", status: "sent" });
  });
});
