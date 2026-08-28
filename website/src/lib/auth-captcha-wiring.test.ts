import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Every auth call that CAN carry a Turnstile token MUST carry one.
//
// Turnstile is fail-soft on the client and enforced server-side by Supabase:
// Auth only starts rejecting tokenless calls once a secret is set in the
// dashboard. That combination makes a missing token invisible until the day
// somebody enables the CAPTCHA — and then the affected call breaks for 100% of
// users with no deploy to correlate it against.
//
// resetPasswordForEmail was in exactly that state: signup, password login and
// phone OTP all passed a token, and password reset - the one path a locked-out
// user has left - did not. Nothing failed, because Turnstile was unconfigured.
//
// This is a source-level check on purpose. The failure it guards against is a
// call site being added or edited without the option, which is a property of
// the code rather than of any runtime state a unit test could set up.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Supabase auth methods whose options bag accepts `captchaToken`. */
const CAPTCHA_CAPABLE = ["signUp", "signInWithPassword", "signInWithOtp", "resend", "resetPasswordForEmail"] as const;

const AUTH_SOURCES = [
  "components/account-auth-form.tsx",
  "components/account-forgot-password-form.tsx",
];

describe("auth CAPTCHA wiring", () => {
  for (const relativePath of AUTH_SOURCES) {
    it(`passes captchaToken on every capable auth call in ${relativePath}`, () => {
      const source = read(relativePath);

      for (const method of CAPTCHA_CAPABLE) {
        const callIndex = source.indexOf(`supabase.auth.${method}(`);
        if (callIndex === -1) continue;

        // The options bag sits inside the call; reading to the next statement
        // boundary is enough to see whether captchaToken is part of it.
        const window = source.slice(callIndex, callIndex + 900);
        expect(
          window.includes("captchaToken"),
          `supabase.auth.${method}() in ${relativePath} does not pass captchaToken. ` +
            "It will fail for every user the moment a Turnstile secret is set in Supabase.",
        ).toBe(true);
      }
    });
  }

  it("keeps the password-reset path reachable from the signup tab", () => {
    const source = read("components/account-auth-form.tsx");

    // The link used to render only under `mode === "login"`, which hid the only
    // recovery route on the exact tab a returning user lands on. Guard the
    // condition itself: signup must never be excluded again.
    expect(source).toContain("/account/forgot-password");
    expect(source).toMatch(/mode === "signup" \|\| loginMethod === "email"/);
    expect(source).not.toMatch(/mode === "login" && loginMethod === "email" \? \(\s*<p>\s*<Link\s+href="\/account\/forgot-password"/);
  });
});
