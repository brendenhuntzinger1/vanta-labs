import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SECOND CONTROL THAT WAS DESCRIBED BUT NOT ENFORCED.
//
// change-password/route.ts closed this exact hole for passwords, and its own
// header claims the change of email came along for the ride:
//
//     "Same move as signup, password reset, the ambassador invite and the
//      change of email."
//
// It had not. account-settings-client.tsx re-authenticated in the BROWSER —
//
//     // Changing the email is security-sensitive: require the current password
//     // first so a hijacked open session can't silently take over the account.
//     await supabase.auth.signInWithPassword({ email: initialEmail, password })
//
// — and then POSTed to /api/account/email-change, which read `email` and
// nothing else. So the control was a comment. Anyone holding the session cookie
// could skip the page entirely:
//
//     POST /api/account/email-change  {"email":"attacker@example.com"}
//
// confirm from their own mailbox, and then take the account outright through
// password reset. That is a worse outcome than the password takeover its
// sibling route closed, because it survives the real owner changing their
// password back — the address the reset link goes to is no longer theirs.
//
// WHY MOCKING THE AUTH BACKEND IS HONEST HERE. What is asserted is never "the
// password was correct" — that is GoTrue's job and mocking it would prove
// nothing. What is asserted is the ROUTE'S OWN CONTROL FLOW: that a request
// with no password, or with one the auth backend rejects, NEVER REACHES
// generateLink. The side effect is the assertion, so a route that quietly
// stopped calling the verifier would fail these even though the fake verifier
// still "works".
// ---------------------------------------------------------------------------

type Attempt = { email: string; password: string };

const state = {
  user: { id: "user-1", email: "owner@example.com", user_metadata: { full_name: "Real Owner" } } as
    | { id: string; email: string; user_metadata: Record<string, unknown> }
    | null,
  /** Passwords the fake auth backend accepts. Everything else is rejected. */
  correctPassword: "CorrectHorse1!",
  reauthAttempts: [] as Attempt[],
  /** THE SIDE EFFECT UNDER TEST — a non-empty list means the change started. */
  mintedLinks: [] as { type: string; email: string; newEmail: string }[],
  sentTo: [] as string[],
  sentHtml: [] as string[],
  rateLimited: false,
};

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => state.user,
  getSessionAccessToken: async () => "access-token",
}));

vi.mock("@/lib/supabase-server", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async ({ email, password }: Attempt) => {
        state.reauthAttempts.push({ email, password });
        return password === state.correctPassword
          ? { data: {}, error: null }
          : { data: null, error: { message: "Invalid login credentials" } };
      },
    },
  }),
  supabaseAdmin: {
    auth: {
      admin: {
        generateLink: async ({ type, email, newEmail }: { type: string; email: string; newEmail: string }) => {
          state.mintedLinks.push({ type, email, newEmail });
          return {
            data: {
              properties: {
                action_link: "https://example.test/confirm",
                hashed_token: "hashed",
                // What GoTrue really echoes: the type generateLink was asked for.
                verification_type: "email_change_new",
              },
            },
            error: null,
          };
        },
      },
    },
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: !state.rateLimited, retryAfterSeconds: 60 }),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async ({ to, html }: { to: string; html: string }) => {
    state.sentTo.push(to);
    state.sentHtml.push(html);
    return { success: true };
  },
}));

vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const { POST } = await import("@/app/api/account/email-change/route");

function post(body: unknown) {
  return POST(new Request("https://example.test/api/account/email-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  state.user = { id: "user-1", email: "owner@example.com", user_metadata: { full_name: "Real Owner" } };
  state.reauthAttempts = [];
  state.mintedLinks = [];
  state.sentTo = [];
  state.sentHtml = [];
  state.rateLimited = false;
});

describe("a session alone cannot change the account's email address", () => {
  it("THE ATTACK: a stolen session with no password mints nothing and mails nobody", async () => {
    // The exact request the old route accepted.
    const response = await post({ email: "attacker@example.com" });

    expect(response.status).toBe(400);
    expect(state.mintedLinks, "a link was minted without a password").toEqual([]);
    expect(state.sentTo, "an email went out without a password").toEqual([]);
  });

  it("a wrong password is refused with 403, and still mints nothing", async () => {
    const response = await post({ email: "attacker@example.com", currentPassword: "not-the-password" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ success: false, error: "Current password is incorrect." });
    expect(state.mintedLinks, "a link was minted after a failed re-auth").toEqual([]);
    expect(state.sentTo).toEqual([]);
  });

  it("the correct password lets the real owner through", async () => {
    // The negative controls above are only meaningful if the positive path
    // works — otherwise a route that refuses everything would pass them all.
    const response = await post({ email: "new@example.com", currentPassword: state.correctPassword });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(state.mintedLinks).toEqual([
      { type: "email_change_new", email: "owner@example.com", newEmail: "new@example.com" },
    ]);
    expect(state.sentTo).toEqual(["new@example.com"]);
  });

  it("the confirmation button stays on our own domain — GoTrue's email_change_new is forwarded as email_change (EMAIL-08)", async () => {
    // The mint above echoes verification_type "email_change_new", which is what
    // GoTrue really returns. That name was not forwardable, so this one email
    // fell back to the raw supabase.co action_link.
    process.env.NEXT_PUBLIC_SITE_URL = "https://www.vantalabsresearch.com";
    const response = await post({ email: "new@example.com", currentPassword: state.correctPassword });
    expect(response.status).toBe(200);
    const html = state.sentHtml[0] ?? "";
    expect(html).toContain("https://www.vantalabsresearch.com/auth/confirm?");
    expect(html).toContain("type=email_change&");
    expect(html).not.toContain("https://example.test/confirm");
  });

  it("re-authenticates as the SESSION's owner, never as an address the caller supplied", async () => {
    // Verifying the password against `newEmail` would let an attacker present
    // an account they already control and pass their own password.
    await post({ email: "attacker@example.com", currentPassword: state.correctPassword });

    expect(state.reauthAttempts).toHaveLength(1);
    expect(state.reauthAttempts[0].email).toBe("owner@example.com");
  });

  it("verifies the password server-side rather than trusting a client-set flag", async () => {
    // The browser used to do this and the server believed the result implicitly.
    // A caller inventing its own "already re-authenticated" claim must not work.
    const response = await post({
      email: "attacker@example.com",
      reauthenticated: true,
      verified: true,
      currentPassword: "",
    });

    expect(response.status).toBe(400);
    expect(state.mintedLinks).toEqual([]);
  });

  it("a signed-out caller is refused before any password is even considered", async () => {
    state.user = null;
    const response = await post({ email: "attacker@example.com", currentPassword: state.correctPassword });

    expect(response.status).toBe(401);
    expect(state.reauthAttempts).toEqual([]);
    expect(state.mintedLinks).toEqual([]);
  });
});

describe("the limiter still stands in front of the password check", () => {
  it("a throttled caller gets 429 and never reaches the verifier", async () => {
    // An endpoint that verifies passwords is a password oracle; the limiter is
    // what stops it being a free one. If the re-auth ran first, the limit would
    // cap the mints and not the guesses.
    state.rateLimited = true;
    const response = await post({ email: "new@example.com", currentPassword: "guess-number-9000" });

    expect(response.status).toBe(429);
    expect(state.reauthAttempts, "the limiter did not stop a password guess").toEqual([]);
    expect(state.mintedLinks).toEqual([]);
  });

  it("but a blank password is answered before the limiter, so a typo costs no attempts", async () => {
    const response = await post({ email: "new@example.com" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Enter your current password to change your email address.",
    });
  });
});
