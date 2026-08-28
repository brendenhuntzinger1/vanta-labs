import { describe, expect, it } from "vitest";
import { resolveSignupOutcome, SIGNUP_CHECK_EMAIL_MESSAGE } from "@/lib/auth-signup-outcome";

// ---------------------------------------------------------------------------
// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// A real applicant (an approved-ambassador prospect who already had an account
// from July) sat in this loop for a full day on 2026-08-28:
//
//   signup  -> "Check your email to continue - we've sent a secure link..."
//   inbox   -> nothing, ever
//   login   -> 400 invalid_credentials (password long forgotten)
//   signup  -> same false promise
//
// Seven `user_repeated_signup` events in the auth log, three failed logins, and
// `recovery_sent_at` still null because the ONLY way out - "Forgot your
// password?" - is not rendered in signup mode.
//
// Supabase deliberately sends NO email when the address already exists, so it
// cannot be used to enumerate accounts. That part is correct and must stay.
// What was wrong is that the UI claimed an email had been sent anyway. The old
// code comment asserted Supabase would send an "you already have an account"
// link that "resolves the distinction privately" - it does not, and never did.
//
// So the invariant under test is BOTH halves at once:
//   1. the outcome must be byte-identical for new and existing addresses
//      (no enumeration signal), AND
//   2. that one shared message must be true for both, and must name the way
//      out for someone who already has an account.
// ---------------------------------------------------------------------------

/** Supabase returns an obfuscated user with NO identities when the email exists. */
const existingAddress = {
  user: { id: "00000000-0000-0000-0000-000000000000", email: "kendra@example.test", identities: [] },
  session: null,
};

/** A genuinely new signup awaiting email confirmation: one identity, no session. */
const newAddress = {
  user: { id: "11111111-1111-1111-1111-111111111111", email: "new@example.test", identities: [{ id: "i-1" }] },
  session: null,
};

/** Auto-confirm projects hand back a live session immediately. */
const newAddressWithSession = {
  user: { id: "22222222-2222-2222-2222-222222222222", email: "auto@example.test", identities: [{ id: "i-2" }] },
  session: { access_token: "token-abc" },
};

describe("resolveSignupOutcome", () => {
  it("does not leak whether the address already has an account", () => {
    const existing = resolveSignupOutcome(existingAddress);
    const fresh = resolveSignupOutcome(newAddress);

    expect(existing).toEqual(fresh);
    expect(existing.kind).toBe("check-email");
  });

  it("proceeds straight into the session when signup returns one", () => {
    const outcome = resolveSignupOutcome(newAddressWithSession);

    if (outcome.kind !== "session") {
      throw new Error(`expected a session outcome, got "${outcome.kind}"`);
    }
    expect(outcome.accessToken).toBe("token-abc");
  });

  it("never promises an email was sent, because for an existing account none is", () => {
    // The exact false claim that stranded her. "We've sent" is a statement of
    // fact that is untrue for half the users who see it.
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).not.toMatch(/we've sent|we have sent|link is on its way/i);
  });

  it("tells someone who already has an account how to get in", () => {
    // Both escape hatches have to be named, or the existing-account half of the
    // audience is told to wait for mail that will never arrive.
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toMatch(/sign in/i);
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toMatch(/reset|forgot/i);
  });

  it("treats a missing user as a hard failure rather than a silent check-email", () => {
    expect(resolveSignupOutcome({ user: null, session: null }).kind).toBe("failed");
  });
});
