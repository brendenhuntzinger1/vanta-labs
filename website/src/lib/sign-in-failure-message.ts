import { isAppleSignInEnabled, isGoogleSignInEnabled } from "@/lib/oauth-providers";

// ---------------------------------------------------------------------------
// WHAT TO SAY WHEN AN EMAIL AND PASSWORD ARE REFUSED.
//
// GoTrue answers "Invalid login credentials" for two completely different
// situations, and the form used to render that string verbatim:
//
//   1. The password is wrong.
//   2. There IS no password. An account created through Google has no password
//      identity at all, so signInWithPassword can only ever fail for it.
//
// Case 2 arrived with the portal and nothing in the app acknowledges it. The
// customer types the password she uses everywhere, is told her credentials are
// wrong, and concludes she has been locked out or that her account is gone. The
// one control that would actually help her — "Forgot your password?", which
// mints a recovery link and lets her set a first one — is labelled as recovery
// for a password she never had, so she has no reason to try it. The provider
// buttons sit below the submit button by design, which on a phone puts them
// under the fold at exactly the moment she needs them.
//
// SO THE MESSAGE NAMES ALL THREE ROUTES, AND LEAKS NOTHING.
//
// It would be easy to fix this by asking the server which kind of account an
// address is. That is an account-enumeration oracle, and this codebase goes to
// real trouble elsewhere to avoid building one (see auth-signup-outcome.ts).
// The message below is shown for EVERY refused password, so it still says
// nothing whatsoever about whether the address is registered or how. It just
// stops hiding the door she needs.
// ---------------------------------------------------------------------------

/** GoTrue's wording for both "wrong password" and "no password exists". */
const CREDENTIALS_REFUSED = /invalid[ _]login[ _]credentials/i;

const FALLBACK = "Unable to sign in. Please try again.";

/** The providers actually on offer, as a phrase, or null when there are none. */
function providerPhrase(): string | null {
  const google = isGoogleSignInEnabled();
  const apple = isAppleSignInEnabled();
  if (google && apple) return "Google or Apple";
  if (google) return "Google";
  if (apple) return "Apple";
  return null;
}

/**
 * The message to show when a password sign-in fails.
 *
 * Anything that is not a credentials refusal is passed through unchanged —
 * "Email not confirmed" and the rate-limit messages are specific, accurate and
 * actionable, and rewriting them would lose information the customer needs.
 */
export function signInFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return FALLBACK;
  if (!CREDENTIALS_REFUSED.test(raw)) return raw;

  const providers = providerPhrase();
  if (!providers) {
    // No provider buttons on the page, so do not send anyone looking for one.
    return (
      "That email and password didn't match. Check your password, or use " +
      "“Forgot your password?” below to set a new one."
    );
  }

  return (
    `That email and password didn't match. If you created your account with ${providers}, ` +
    `use “Continue with ${providers}” below instead. Otherwise, use “Forgot your password?” ` +
    "to set a new one — that works even if you have never had a password."
  );
}
