import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  accountConfirmationResendTemplate,
  accountConfirmationTemplate,
} from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE EMAIL THAT WAS DELIVERED AND STILL DID NOT WORK (2026-08-29).
//
// Every mechanical check on the old path came back clean: the Supabase template
// carried {{ .ConfirmationURL }} inside the anchor, custom SMTP was on and
// pointed at Resend on the documented port, Supabase logged no send error, the
// tokens were minted and unspent, and RESEND REPORTED DELIVERED. Four of nine
// signups over four days still never confirmed.
//
// What was wrong was the message itself. Supabase's default confirmation is a
// bare <h2>, one sentence and a naked <a> — the shape of a phishing email — and
// Gmail filed it as one, while the branded order confirmations on the same
// domain through the same Resend account landed every time.
//
// So these tests pin the two properties that mattered, because "the link is in
// the HTML" was true of the version that failed:
//
//   1. the link is present and reachable as a real CTA, and
//   2. the message is branded, i.e. it goes through renderLayout rather than
//      being another naked anchor with a different sender.
// ---------------------------------------------------------------------------

const CONFIRM_URL = "https://mlpimwgkwuqpsvsrlpqv.supabase.co/auth/v1/verify?token=abc&type=signup";
/** renderLayout escapes the href, so `&` arrives as `&amp;`. That is correct
 *  HTML and the browser un-escapes it; asserting the raw URL would fail on a
 *  template that is working. */
const CONFIRM_URL_IN_HTML = CONFIRM_URL.replace(/&/g, "&amp;");

describe("accountConfirmationTemplate", () => {
  const template = accountConfirmationTemplate({ name: "Zain", confirmUrl: CONFIRM_URL });

  it("puts the confirmation URL in an anchor href, correctly escaped", () => {
    expect(template.html).toContain(`href="${CONFIRM_URL_IN_HTML}"`);
  });

  it("renders the link as a real button, not a bare anchor", () => {
    // The whole reason this moved. renderLayout's CTA is a padded, rounded,
    // high-contrast pill; the Supabase default was an unstyled inline link that
    // a person skims straight past even when it does reach the inbox.
    const cta = template.html.slice(template.html.indexOf(CONFIRM_URL_IN_HTML));
    expect(cta).toContain("display:inline-block");
    expect(cta).toContain("border-radius:999px");
    expect(template.html).toContain("Confirm my email");
  });

  it("is branded, so it does not read as phishing", () => {
    expect(template.html).toContain("Vanta Labs");
    expect(template.html).toContain("support@vantalabsresearch.com");
    // renderLayout's dark card. Present here and absent from the old Supabase
    // template, which is the entire difference between filed and delivered.
    expect(template.html).toContain("background:#050505");
  });

  it("carries the link in the plain-text part too", () => {
    // Some clients render text/plain, and a confirmation with no link there is
    // the same dead end in a different costume.
    expect(template.text).toContain(CONFIRM_URL);
  });

  it("greets by first name when there is one, and stays correct without", () => {
    expect(template.html).toContain("Welcome, Zain");
    const anonymous = accountConfirmationTemplate({ name: "", confirmUrl: CONFIRM_URL });
    expect(anonymous.html).toContain("Confirm your email");
    expect(anonymous.html).not.toContain("Welcome, </h1>");
  });

  it("escapes a name rather than interpolating markup", () => {
    const hostile = accountConfirmationTemplate({
      name: '<script>alert(1)</script>',
      confirmUrl: CONFIRM_URL,
    });
    expect(hostile.html).not.toContain("<script>");
  });

  it("has a subject that says what it is", () => {
    expect(template.subject.toLowerCase()).toContain("confirm");
  });
});

describe("accountConfirmationResendTemplate", () => {
  const template = accountConfirmationResendTemplate({ name: "Zain", confirmUrl: CONFIRM_URL });

  it("is branded and carries the link the same way", () => {
    expect(template.html).toContain(`href="${CONFIRM_URL_IN_HTML}"`);
    expect(template.html).toContain("border-radius:999px");
    expect(template.html).toContain("Vanta Labs");
    expect(template.text).toContain(CONFIRM_URL);
  });

  it("says the link is single-use, because a magic link is", () => {
    expect(template.html.toLowerCase()).toContain("once");
  });
});

// ---------------------------------------------------------------------------
// The route that sends them. Source-level, because exercising it for real needs
// a live GoTrue admin API — the harness gotrue shim implements neither
// generateLink nor the admin user list, so a mocked test here would be a test
// of the mock. What is pinned is the wiring that regressed or could.
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(join(process.cwd(), "src/app/api/auth/signup/route.ts"), "utf8");
/** The resend/fallback half lives here, shared with /api/auth/resend-confirmation. */
const CONFIRM_LIB = readFileSync(join(process.cwd(), "src/lib/auth-confirmation-email.ts"), "utf8");
const RESEND_ROUTE = readFileSync(join(process.cwd(), "src/app/api/auth/resend-confirmation/route.ts"), "utf8");
const FORM = readFileSync(join(process.cwd(), "src/components/account-auth-form.tsx"), "utf8");

describe("POST /api/auth/signup", () => {
  it("mints the link with the admin API rather than letting Supabase mail it", () => {
    expect(ROUTE).toContain("generateLink");
    expect(ROUTE).toContain('type: "signup"');
  });

  it("sends it through sendEmail, so it inherits the provider and bounce webhook", () => {
    expect(ROUTE).toContain("sendEmail(");
    expect(ROUTE).toContain("accountConfirmationTemplate");
  });

  it("verifies the captcha server-side", () => {
    // The browser used to hand its token to Supabase. Nothing else guards this
    // route, and it creates accounts.
    expect(ROUTE).toContain("verifyTurnstileToken");
  });

  it("rate limits per IP and per address", () => {
    expect(ROUTE).toContain("signup-ip");
    expect(ROUTE).toContain("signup-email:");
  });

  it("answers identically whether or not the address already has an account", () => {
    // generateLink ERRORS with "user already registered" where signUp() returns
    // an obfuscated success. That difference must not reach the client, or the
    // signup form becomes the account oracle auth-signup-outcome.ts avoids.
    expect(ROUTE).toContain("GENERIC_RESPONSE");
    // The real property: no Supabase error text is ever interpolated into a
    // response body. (The phrase appears in this route's header comment, which
    // is why this checks the responses rather than the file.)
    expect(ROUTE).not.toMatch(/NextResponse\.json\([^)]*error\.message/);
    expect(ROUTE).not.toMatch(/NextResponse\.json\([^)]*generateLink/);
  });

  it("never logs the password", () => {
    const logCalls = ROUTE.match(/console\.(error|log|warn)\([^)]*\)/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toContain("password");
    }
  });

  it("only re-sends to an account that is still unconfirmed", () => {
    // Mailing a sign-in link to anyone who types a CONFIRMED address into the
    // signup form would be a nuisance vector. Unconfirmed is the one state
    // where the person is provably stuck.
    expect(CONFIRM_LIB).toContain("findUnconfirmedUser");
    expect(CONFIRM_LIB).toContain("email_confirmed_at");
    // Both entry points go through the one implementation, so there is only
    // one enumeration-safe path to get wrong.
    expect(ROUTE).toContain("sendBrandedConfirmationResend");
    expect(RESEND_ROUTE).toContain("sendBrandedConfirmationResend");
  });

  it("falls back to Supabase's own send and alerts when the provider refuses", () => {
    // Moving the send in-house makes our provider a new single point of failure
    // for account access; the fallback is what keeps the change additive.
    expect(CONFIRM_LIB).toContain("auth.resend(");
    expect(CONFIRM_LIB).toContain("signup_confirmation_provider_failed");
    expect(ROUTE).toContain("fallBackToSupabaseConfirmation");
  });
});

describe("the signup form", () => {
  it("posts to the route", () => {
    expect(FORM).toContain('"/api/auth/signup"');
  });

  it("still falls back to the client signUp if the route is unreachable", () => {
    // Strictly additive: at worst signup behaves exactly as it did before.
    expect(FORM).toContain("supabase.auth.signUp(");
  });

  it("shows the shared check-email copy, which is true for new and returning alike", () => {
    expect(FORM).toContain("SIGNUP_CHECK_EMAIL_MESSAGE");
  });
});

// ---------------------------------------------------------------------------
// The resend button. It used to call supabase.auth.resend() from the browser,
// which mails Supabase's own template — the message Gmail filed as spam, links
// stripped. Re-sending someone an identical copy of the email they already
// could not use is not a recovery path.
// ---------------------------------------------------------------------------

describe("POST /api/auth/resend-confirmation", () => {
  it("sends a branded magic link rather than Supabase's template", () => {
    expect(RESEND_ROUTE).toContain("sendBrandedConfirmationResend");
    expect(CONFIRM_LIB).toContain("accountConfirmationResendTemplate");
    expect(CONFIRM_LIB).toContain('type: "magiclink"');
  });

  it("is enumeration-safe, rate limited and captcha-verified like its siblings", () => {
    expect(RESEND_ROUTE).toContain("GENERIC_RESPONSE");
    expect(RESEND_ROUTE).toContain("verifyTurnstileToken");
    expect(RESEND_ROUTE).toContain("resend-confirmation-ip");
    expect(RESEND_ROUTE).toContain("resend-confirmation-email:");
  });

  it("the form posts to it instead of calling Supabase directly", () => {
    expect(FORM).toContain('"/api/auth/resend-confirmation"');
    expect(FORM).not.toContain('supabase.auth.resend(');
  });
});

// ---------------------------------------------------------------------------
// THE SILENT-FAILURE BRANCH ON THE LAST PATH A LOCKED-OUT CUSTOMER HAS.
//
// deliverResetEmail returned early on `error || !action_link`, which is two
// different things wearing one branch. "No account for this address" is fine to
// swallow — saying anything is the enumeration leak the route exists to avoid.
// "That address HAS an account and minting failed" is not: the customer has
// just been told a link is on its way, nothing was sent, no retry is queued,
// and nobody was told. Same shape as the incident, on password reset.
//
// The response must stay byte-identical either way; only the telemetry differs.
// ---------------------------------------------------------------------------

const RESET_ROUTE = readFileSync(join(process.cwd(), "src/app/api/auth/password-reset/route.ts"), "utf8");

describe("password reset, when the link cannot be minted", () => {
  it("distinguishes a missing account from a real failure", () => {
    expect(RESET_ROUTE).toContain("findUserByEmail");
  });

  it("alerts when the address exists and nothing was sent", () => {
    expect(RESET_ROUTE).toContain("password_reset_mint_failed");
    // Critical, not warning: this is a customer who cannot get back in and has
    // been told otherwise.
    const alertBlock = RESET_ROUTE.slice(RESET_ROUTE.indexOf("password_reset_mint_failed"));
    expect(alertBlock.slice(0, 200)).toContain('severity: "critical"');
  });

  it("still says nothing different to the client", () => {
    // The whole point: telemetry gained, enumeration safety untouched. There is
    // exactly one response shape and the failure branch returns without one.
    expect(RESET_ROUTE).toContain("GENERIC_RESPONSE");
    const branch = RESET_ROUTE.slice(
      RESET_ROUTE.indexOf("const existing = await findUserByEmail"),
      RESET_ROUTE.indexOf("const template = passwordResetTemplate"),
    );
    expect(branch).not.toContain("NextResponse");
  });

  it("shares one account lookup with the confirmation paths", () => {
    expect(CONFIRM_LIB).toContain("export async function findUserByEmail");
    expect(CONFIRM_LIB).toContain("findUserByEmail(email)");
  });
});
