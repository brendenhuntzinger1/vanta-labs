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
//
// AND ONE MORE GATE, WHICH THE ENV VAR CANNOT OPEN ON ITS OWN.
//
// The express lane (api/checkout/express/session + authorize) prices its quotes
// WITHOUT the one-time offer cookie and stamps NO email attribution, so a
// wallet customer would silently lose the gift their email promised and the
// sale would never be credited to the automation or campaign that produced it
// (audit, 2026-09-04). Until those routes carry the same wiring the card lane
// has — readOfferCookie/offerToken into the quote, reserveCustomerOffer before
// the order, attributeOrderToAutomation + attributeOrderToCampaign after it —
// this stays false, and express-checkout-parity-guard.test.ts refuses to let
// it become true while any of that is missing. Flipping the env var alone
// changes nothing, which is the point.
export const EXPRESS_OFFER_PARITY = false;

export const EXPRESS_CHECKOUT_ENABLED =
  process.env.NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED === "true" && EXPRESS_OFFER_PARITY;

// Hosts registered for Apple Pay, comma-separated.
//
// Native Apple Pay validates the EXACT host serving the page. On an
// unregistered host the sheet fails merchant validation with an opaque error on
// a page that otherwise looks fine, so the button must not render there at all.
// Note the apex and the www host are DIFFERENT registrations; whichever one the
// browser actually lands on is the one that matters.
function parseApplePayDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export const APPLE_PAY_DOMAINS: string[] = parseApplePayDomains(
  process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS,
);

export function isRegisteredApplePayHost(hostname: string): boolean {
  // Read at CALL time, not module-load time. NEXT_PUBLIC_* is inlined at build
  // so this is the same value in the browser, but it lets the eligibility gate
  // be exercised against a configured host list in tests instead of silently
  // answering false for every host because the suite has no env set.
  return parseApplePayDomains(process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS).includes(
    hostname.trim().toLowerCase(),
  );
}

// Deliberately a user-agent test rather than `window.ApplePaySession` /
// `canMakePayments()`: Apple's own apple-pay-sdk.js makes both truthy on
// desktop Chrome, which renders an Express Checkout section that can never
// complete. Presence of ApplePaySession is still required separately — this
// only rules the platform in.
export function isApplePlatform(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(userAgent);
}

// ---------------------------------------------------------------------------
// MAY WE OFFER APPLE PAY HERE?
//
// One predicate, because there are two surfaces that must agree: the express
// BUTTON and the accepted-methods PILL under the checkout CTA. The pill used to
// key off EXPRESS_CHECKOUT_ENABLED alone, so a shopper on desktop Chrome — or,
// far worse, an iPhone on the unregistered www host — was told Apple Pay was
// accepted while no button ever rendered. Advertising a wallet that cannot be
// used is the one failure mode this whole file exists to prevent.
//
// Every field is a browser fact read at the call site rather than in here, so
// this stays pure and directly testable.
// ---------------------------------------------------------------------------
export interface ApplePayEnvironment {
  /** NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED. */
  enabled: boolean;
  userAgent: string;
  /** The EXACT host serving the page — apex and www are separate registrations. */
  hostname: string;
  /** `typeof window.ApplePaySession !== "undefined"`. */
  hasApplePaySession: boolean;
  /**
   * `ApplePaySession.supportsVersion(APPLE_PAY_VERSION)`. Below iOS 13.4 /
   * macOS 10.15.4 the v6 constructor THROWS rather than returning anything, so
   * it must be checked before the button renders — not caught at tap time, by
   * which point the shopper has already committed.
   */
  supportsVersion: boolean;
  /** `ApplePaySession.canMakePayments()` — a wallet with a card provisioned. */
  canMakePayments: boolean;
}

export function canOfferApplePay(environment: ApplePayEnvironment): boolean {
  return (
    environment.enabled &&
    isApplePlatform(environment.userAgent) &&
    environment.hasApplePaySession &&
    environment.supportsVersion &&
    environment.canMakePayments &&
    isRegisteredApplePayHost(environment.hostname)
  );
}
