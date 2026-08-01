// The "Apple Pay" express-checkout button is only functional once a payment
// processor's Apple Pay integration is wired to it AND the serving domain is
// registered with the wallet tokenization provider. Until then it would be a
// cosmetic control that merely opens the normal checkout form — misleading to a
// shopper who taps it expecting a one-tap Apple Pay sheet, and an unlicensed
// use of the Apple Pay mark. So it (and the Apple Pay accepted-payment pill)
// stays hidden by default.
//
// To turn it on: run src/lib/sql/express-checkout.sql, register the serving
// host for Apple Pay, set the env vars documented in .env.example, then set the
// flag below to "true" in the deployment environment (Vercel).
export const EXPRESS_CHECKOUT_ENABLED =
  process.env.NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED === "true";

// Hosts registered for Apple Pay, comma-separated.
//
// Native Apple Pay validates the EXACT host serving the page. On an
// unregistered host the sheet fails merchant validation with an opaque error on
// a page that otherwise looks fine, so the button must not render there at all.
// Note the apex and the www host are DIFFERENT registrations; whichever one the
// browser actually lands on is the one that matters.
export const APPLE_PAY_DOMAINS: string[] = (process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

export function isRegisteredApplePayHost(hostname: string): boolean {
  return APPLE_PAY_DOMAINS.includes(hostname.trim().toLowerCase());
}

// Deliberately a user-agent test rather than `window.ApplePaySession` /
// `canMakePayments()`: Apple's own apple-pay-sdk.js makes both truthy on
// desktop Chrome, which renders an Express Checkout section that can never
// complete. Presence of ApplePaySession is still required separately — this
// only rules the platform in.
export function isApplePlatform(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(userAgent);
}
