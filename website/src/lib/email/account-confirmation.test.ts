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
    expect(ROUTE).toContain("findUnconfirmedUser");
    expect(ROUTE).toContain("email_confirmed_at");
  });

  it("falls back to Supabase's own send and alerts when the provider refuses", () => {
    // Moving the send in-house makes our provider a new single point of failure
    // for account access; the fallback is what keeps the change additive.
    expect(ROUTE).toContain("auth.resend(");
    expect(ROUTE).toContain("signup_confirmation_provider_failed");
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
