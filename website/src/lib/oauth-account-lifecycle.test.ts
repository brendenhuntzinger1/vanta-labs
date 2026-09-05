import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasPasswordIdentity, signInProviders } from "@/lib/account-identity";
import { signInFailureMessage } from "@/lib/sign-in-failure-message";
import { SIGNUP_CHECK_EMAIL_MESSAGE } from "@/lib/auth-signup-outcome";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip comments so prose ABOUT a rule is not mistaken for the rule. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const form = code(read("src/components/account-auth-form.tsx"));
const callback = code(read("src/app/account/auth/callback/page.tsx"));
const sessionRoute = code(read("src/app/api/auth/session/route.ts"));
const changePassword = code(read("src/app/api/account/change-password/route.ts"));
const settingsClient = code(read("src/components/account-settings-client.tsx"));
const marketing = code(read("src/lib/marketing-broadcast.ts"));

// ---------------------------------------------------------------------------
// WHAT HAPPENS TO AN ACCOUNT THAT HAS NO PASSWORD.
//
// Until the portal added Google, every account had one — all 41 identities on
// the live project are `email`. Several things were built on that assumption
// and each of them fails a provider account with a statement that is not merely
// unhelpful but false: "Current password is incorrect", about a password that
// never existed. None of them had a route out inside the app.
// ---------------------------------------------------------------------------

describe("hasPasswordIdentity", () => {
  it("is true for an ordinary email account", () => {
    expect(hasPasswordIdentity({ identities: [{ provider: "email" }] as never })).toBe(true);
  });

  it("is false for a Google-only account", () => {
    expect(hasPasswordIdentity({ identities: [{ provider: "google" }] as never })).toBe(false);
  });

  it("is true once a provider account has added a password", () => {
    expect(
      hasPasswordIdentity({ identities: [{ provider: "google" }, { provider: "email" }] as never }),
    ).toBe(true);
  });

  it("FAILS SAFE to true when identities are missing", () => {
    // Callers use this to decide whether to relax a security check, so the
    // unknown case must keep the check rather than drop it.
    expect(hasPasswordIdentity(null)).toBe(true);
    expect(hasPasswordIdentity(undefined)).toBe(true);
    expect(hasPasswordIdentity({ identities: undefined })).toBe(true);
    expect(hasPasswordIdentity({ identities: [] as never })).toBe(true);
  });

  it("lists the providers an account signs in with, de-duplicated", () => {
    expect(
      signInProviders({ identities: [{ provider: "google" }, { provider: "google" }] as never }),
    ).toEqual(["google"]);
    expect(signInProviders(null)).toEqual([]);
  });
});

describe("a provider account can set a first password", () => {
  it("does not demand a current password it cannot have", () => {
    expect(changePassword).toContain("const settingFirstPassword = !hasPasswordIdentity(user)");
    expect(changePassword).toContain("if (!settingFirstPassword && !currentPassword)");
  });

  it("skips only the re-authentication, and nothing else", () => {
    // The rate limits are what stop this route being a free password oracle,
    // and they must still run for the first-password case.
    const guardAt = changePassword.indexOf("if (!settingFirstPassword) {");
    const limitAt = changePassword.indexOf("checkRateLimit(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(-1);
    expect(limitAt, "rate limiting must happen before the re-auth branch").toBeLessThan(guardAt);
    // The re-auth itself is still there for every account that has a password.
    expect(changePassword).toContain("auth.signInWithPassword({");
  });

  it("leaves the email-change gate untouched", () => {
    // Its own header argues at length that this check is what stops a hijacked
    // session taking the account. Provider accounts get there by setting a
    // password first, not by the gate being relaxed for them.
    const emailChange = code(read("src/app/api/account/email-change/route.ts"));
    expect(emailChange).toContain("auth.signInWithPassword({");
    expect(emailChange).not.toContain("hasPasswordIdentity");
  });

  it("shows a card the customer can actually use", () => {
    expect(settingsClient).toContain('hasPassword ? "Change password" : "Add a password"');
    // The current-password field is not merely disabled, it is not rendered.
    expect(settingsClient).toContain("{hasPassword ? (");
    // And the email card explains the real prerequisite instead of a falsehood.
    expect(settingsClient).toContain("Add one under Security first");
  });
});

describe("the sign-in failure tells a provider customer where her door is", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites the credentials refusal, which means two different things", () => {
    const msg = signInFailureMessage(new Error("Invalid login credentials"));
    expect(msg).toContain("Google");
    expect(msg).toContain("Forgot your password?");
    // And it never asserts anything about whether the address is registered.
    expect(msg).not.toMatch(/no account|not registered|does not exist/i);
  });

  it("passes through messages that are already specific and actionable", () => {
    // "Email not confirmed" and the rate-limit messages tell the customer
    // something true that our generic text would destroy.
    expect(signInFailureMessage(new Error("Email not confirmed"))).toBe("Email not confirmed");
    expect(signInFailureMessage(new Error("Request rate limit reached"))).toBe(
      "Request rate limit reached",
    );
  });

  it("does not send anyone after a provider button that is not on the page", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED", "false");
    const msg = signInFailureMessage(new Error("Invalid login credentials"));
    expect(msg).not.toContain("Google");
    expect(msg).not.toContain("Apple");
    expect(msg).toContain("Forgot your password?");
  });

  it("has a sane answer for a non-Error", () => {
    expect(signInFailureMessage(null)).toBe("Unable to sign in. Please try again.");
    expect(signInFailureMessage(new Error("   "))).toBe("Unable to sign in. Please try again.");
  });

  it("is what the form actually renders", () => {
    expect(form).toContain("setError(signInFailureMessage(submitError))");
  });
});

describe("the signup message covers the customer who has no password", () => {
  it("names the provider route alongside the two it always offered", () => {
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toContain("Google");
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toContain("Forgot your password?");
  });

  it("stays enumeration-safe: it asserts nothing about this address", () => {
    // The whole message is conditional prose, offered to every address.
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toContain("If this address is new");
    expect(SIGNUP_CHECK_EMAIL_MESSAGE).toContain("If you already have an account");
  });
});

// ---------------------------------------------------------------------------
// THE THINGS THAT CROSS THE PROVIDER ROUND TRIP.
//
// Google hands back an identity and nothing else, so anything the store needs
// to know about this visitor has to survive the trip on our side. Three things
// do: the two attestations, the optional marketing tick, and the ambassador who
// sent them. The last one was missing entirely.
// ---------------------------------------------------------------------------

describe("referral attribution survives a provider sign-in", () => {
  it("is carried across the round trip", () => {
    expect(form).toContain('window.sessionStorage.setItem("vl-oauth-referral", referralCodeFromUrl)');
    expect(callback).toContain('sessionStorage.getItem("vl-oauth-referral")');
    expect(callback).toContain("oauthReferralCode: signIn.referralCode");
  });

  it("is bounded and character-restricted before it is stored", () => {
    // It survives a trip through two external services and is written to
    // user_metadata, so it is attacker-supplied by construction.
    expect(sessionRoute).toContain("body.oauthReferralCode.trim().slice(0, 64)");
    expect(sessionRoute).toMatch(/replace\(\/\[\^A-Za-z0-9_-\]\/g, ""\)/);
  });

  it("never re-points an account that already carries a code", () => {
    // A later sign-in must not be able to re-attribute an existing customer.
    expect(sessionRoute).toContain("const referredByCode = storedReferralCode || oauthReferralCode");
    expect(sessionRoute).toContain("if (!storedReferralCode && referredByCode)");
  });

  it("is cleared with the rest, only after the server accepts it", () => {
    const clearAt = callback.indexOf('removeItem("vl-oauth-referral")');
    const postAt = callback.indexOf('"/api/auth/session"');
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(postAt);
  });
});

describe("consent only counts from a screen that shows the box", () => {
  it("is gated on the box being on this screen, not on stale state", () => {
    // marketingOptIn survives a mode switch; the checkbox does not. Someone who
    // ticked it at the portal and then chose "Already have an account? Sign in"
    // would have been subscribed from a screen with no box to untick, whose only
    // sentence about marketing promised it would not happen.
    expect(form).toContain('const marketingBoxOnScreen = mode === "portal" || mode === "signup"');
    expect(form).toContain("const marketingConsent = marketingBoxOnScreen && marketingOptIn");
    expect(form).toContain('setItem("vl-oauth-marketing", marketingConsent ? "true" : "false")');
  });

  it("only promises what is true on the screen making the promise", () => {
    // Signup mode shows a marketing checkbox directly above this sentence.
    expect(form).toContain('mode === "signup"');
    expect(form).toContain("Whether we email you is set by the checkbox above.");
    expect(form).toContain("It does not subscribe you to marketing email.");
  });
});

describe("an attestation that did not arrive is re-asked, never assumed", () => {
  it("reads the write back so the failure is at least visible", () => {
    expect(form).toContain('attestationStored = window.sessionStorage.getItem("vl-oauth-attested") === "true"');
    expect(form).toContain("the callback will re-ask");
  });

  it("does NOT refuse the provider door over it", () => {
    // The marker can also be written successfully and then be unreachable —
    // Google refuses OAuth in embedded webviews, so an in-app-browser visitor is
    // bounced to the system browser where this tab does not exist. Blocking at
    // this end cannot detect that case and would refuse people the far end can
    // serve perfectly well.
    const at = form.indexOf("if (!attestationStored) {");
    expect(at).toBeGreaterThan(-1);
    const block = form.slice(at, at + 220);
    expect(block, "startOAuth must not bail out here").not.toContain("return;");
  });

  it("re-asks at the callback when the marker did not arrive", () => {
    // Failing open writes no age_confirmed_21, no research_use_only_agreed and
    // no timestamp, and nothing in the app ever re-asks or backfills — so the
    // gap would be permanent for that account and invisible to the owner.
    expect(callback).toContain("if (!attested) {");
    const at = callback.indexOf("if (!attested) {");
    expect(callback.slice(at, at + 160)).toContain("setPending(signIn)");
  });

  it("posts nothing until both boxes are ticked on the re-ask", () => {
    expect(callback).toContain("if (!pending || !ageConfirmed || !researchUseAgreed || submitting) return");
    // And what it then sends is a real attestation, not the absent one.
    expect(callback).toContain("await completeSignIn(pending, true, destination)");
  });

  it("renders the same two statements the portal asks", () => {
    expect(callback).toContain("I confirm I am 21 years of age or older");
    expect(callback).toContain("I understand products are offered exclusively for research use");
    expect(callback).toContain("disabled={!ageConfirmed || !researchUseAgreed || submitting}");
  });
});

// ---------------------------------------------------------------------------
// WRITES THAT WERE REFUSED USED TO LOOK EXACTLY LIKE WRITES THAT SUCCEEDED.
//
// admin.updateUserById catches every GoTrue non-2xx and RETURNS it; PostgREST
// builders default to not throwing. So try/catch around either only ever fires
// on a raw network throw, and the refusals that actually happen — a 429 under
// load, a service-key rotation, a constraint change — passed as success with
// nothing in the logs.
// ---------------------------------------------------------------------------

describe("a refused write is visible", () => {
  it("inspects the error the attestation write returns", () => {
    expect(sessionRoute).toContain("const { error: attestationError } = await supabaseAdmin.auth.admin.updateUserById(");
    expect(sessionRoute).toContain("if (attestationError) {");
  });

  it("inspects the error the marketing preference write returns", () => {
    expect(sessionRoute).toContain("const { error: preferenceError } = await supabaseAdmin");
    expect(sessionRoute).toContain("if (preferenceError) {");
  });

  it("makes the subscriber write report whether it landed", () => {
    expect(marketing).toContain("Promise<boolean>");
    expect(marketing).toContain("if (error) {");
    expect(sessionRoute).toContain("if (subscribed === false) {");
  });

  it("says so when an account is admitted with no attestation on file", () => {
    // Nothing in the app reads these flags back, so an absent one is invisible
    // forever unless something records it at the moment it happens.
    expect(sessionRoute).toContain("account admitted with no 21+/research-use attestation on file");
  });
});
