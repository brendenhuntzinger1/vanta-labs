import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SECOND CLICK MUST NOT KILL THE FIRST LINK.
//
// `auth.users.recovery_token` is a single column, so every recovery link
// minted for an address replaces the token inside the one minted before it.
// The once-a-minute debounce exists so a customer who clicks "send reset link"
// twice gets ONE email with ONE working link.
//
// That only holds if the slot is claimed BEFORE the link is minted. Minting
// first and claiming second means the second click mints token B (killing the
// link carrying token A that is already in the inbox), is then refused by the
// debounce, and sends nothing. The customer holds a dead link and no second
// email, on the one path a locked-out person has left.
// ---------------------------------------------------------------------------

const calls: string[] = [];

const generateLink = vi.fn(async () => {
  calls.push("generateLink");
  return {
    data: {
      user: { email: "customer@example.test", user_metadata: { full_name: "Casey Customer" } },
      properties: {
        action_link: "https://project.supabase.co/auth/v1/verify?token=hashed-a&type=recovery",
        hashed_token: "hashed-a",
        verification_type: "recovery",
      },
    },
    error: null,
  };
});
const resetPasswordForEmail = vi.fn(async () => ({ data: {}, error: null }));
const claimAuthEmailSend = vi.fn(async () => {
  calls.push("claim");
  return true;
});
const releaseAuthEmailClaim = vi.fn(async () => {
  calls.push("release");
});
const recordAuthEmailAttempt = vi.fn(async () => {});
const sendEmail = vi.fn(async () => {
  calls.push("sendEmail");
  return { success: true };
});
const recordSystemAlert = vi.fn(async () => {});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { auth: { admin: { generateLink } } },
  createServerClient: () => ({ auth: { resetPasswordForEmail } }),
}));
vi.mock("@/lib/auth-email-audit", () => ({ claimAuthEmailSend, recordAuthEmailAttempt, releaseAuthEmailClaim }));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: async () => ({ ok: true, reason: "not-configured" }) }));
vi.mock("@/lib/auth-confirmation-email", () => ({ findUserByEmail: async () => null }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));

async function requestReset() {
  const { POST } = await import("@/app/api/auth/password-reset/route");
  const request = new Request("https://www.vantalabsresearch.com/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "customer@example.test" }),
  });
  return POST(request);
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("password reset: the debounce claim comes before the mint", () => {
  it("claims the once-a-minute slot BEFORE minting the recovery link", async () => {
    await requestReset();
    expect(calls.indexOf("claim")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("generateLink")).toBeGreaterThan(calls.indexOf("claim"));
    expect(calls.indexOf("sendEmail")).toBeGreaterThan(calls.indexOf("generateLink"));
  });

  it("a second request inside the minute mints NOTHING, so the link already in the inbox stays valid", async () => {
    claimAuthEmailSend.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = await requestReset();
    const second = await requestReset();

    expect(generateLink).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The refused request must not fall through to Supabase's own sender either —
    // that path mints a token too.
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    // Enumeration safety: both answers are the generic one.
    expect(await first.json()).toEqual(await second.json());
  });

  it("releases the slot when the mint refuses (no account, or the admin API failed), so a later retry is not locked out", async () => {
    generateLink.mockResolvedValueOnce({ data: { user: null, properties: null }, error: { message: "user not found" } } as never);
    await requestReset();
    expect(releaseAuthEmailClaim).toHaveBeenCalledWith("password_reset", "customer@example.test");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is pinned in the source: the claim precedes generateLink inside deliverResetEmail", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/auth/password-reset/route.ts"), "utf8");
    const body = source.slice(source.indexOf("async function deliverResetEmail"));
    const claimAt = body.indexOf("claimAuthEmailSend(");
    const mintAt = body.indexOf("generateLink(");
    expect(claimAt).toBeGreaterThan(-1);
    expect(mintAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(mintAt);
  });
});
