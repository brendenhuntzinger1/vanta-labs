// WHICH PROVIDER BUTTONS THE PORTAL IS ALLOWED TO OFFER.
//
// A provider button is only functional once that provider is enabled in the
// Supabase dashboard with a real client ID and secret. Until then the button
// renders perfectly, the visitor taps it, and Supabase answers 400 "Unsupported
// provider: provider is not enabled" — an error the visitor cannot act on, on
// the one screen standing between them and the entire catalog. A dead control
// on the front door is worse than no control at all, so a provider must be
// declared here before it is shown.
//
// Measured against the live project on 2026-09-05, by asking GoTrue's authorize
// endpoint for each provider in turn:
//
//     google   302 -> accounts.google.com   (enabled)
//     apple    400                          (not enabled)
//
// THE TWO DEFAULTS ARE DELIBERATELY DIFFERENT, and neither is a guess.
//
// Google is enabled on the project today, so it defaults ON and the env var
// exists to switch it OFF — if the credentials are ever rotated or revoked, an
// operator can hide the button in one Vercel setting without a deploy.
//
// Apple has never been configured (it needs the paid Apple Developer Program),
// so it defaults OFF and the env var exists to switch it ON. That asymmetry is
// the point: the default state of each flag is the true state of the project,
// so a fresh deployment with no env vars set is correct rather than broken.
//
// TO TURN APPLE ON, in this order:
//   1. Enrol in the Apple Developer Program and create a Services ID.
//   2. Enable Apple in Supabase → Authentication → Providers, with that
//      Services ID and the generated client secret.
//   3. Confirm it, exactly as the table above was confirmed:
//        curl -s -o /dev/null -w '%{http_code}\n' \
//          'https://<project>.supabase.co/auth/v1/authorize?provider=apple'
//      302 means enabled; 400 means it is still not.
//   4. Only then set NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED=true in Vercel.
//
// Doing step 4 first puts the dead button straight back.

function flag(raw: string | undefined, fallback: boolean): boolean {
  // Read at CALL time rather than module-load time. NEXT_PUBLIC_* is inlined at
  // build so the browser sees the same value either way, but this lets the
  // tests exercise both states instead of every assertion collapsing onto
  // whatever the suite's environment happens to be.
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** Google is configured on the project; the env var exists to switch it off. */
export function isGoogleSignInEnabled(): boolean {
  return flag(process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED, true);
}

/** Apple is NOT configured; the env var exists to switch it on once it is. */
export function isAppleSignInEnabled(): boolean {
  return flag(process.env.NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED, false);
}

/**
 * True when the portal has at least one working provider to offer.
 *
 * The provider block, the rule above it and the "or" divider below it are one
 * composition: with nothing to divide, the divider is a line pointing at empty
 * space. Callers use this to drop the whole group together rather than leaving
 * its furniture behind.
 */
export function hasAnyOAuthProvider(): boolean {
  return isGoogleSignInEnabled() || isAppleSignInEnabled();
}
