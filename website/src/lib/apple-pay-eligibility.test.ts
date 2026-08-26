import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canOfferApplePay, type ApplePayEnvironment } from "@/lib/express-checkout";

// ---------------------------------------------------------------------------
// NEVER ADVERTISE A WALLET THE SHOPPER CANNOT USE.
//
// Reproduced in the browser. The accepted-methods line under the checkout CTA
// read "Apple Pay · Visa · Mastercard · Amex · Discover" while no Apple Pay
// button rendered anywhere on the page, because the two were gated differently:
//
//     pill    EXPRESS_CHECKOUT_ENABLED
//     button  EXPRESS_CHECKOUT_ENABLED
//             + isApplePlatform(userAgent)
//             + window.ApplePaySession (+ supportsVersion + canMakePayments)
//             + isRegisteredApplePayHost(hostname)
//
// The host check is the one that bites in production: express-checkout.ts notes
// that the apex and the www host are SEPARATE Apple registrations. A shopper on
// an iPhone landing on the unregistered host is shown Apple Pay as an accepted
// method and given no way to pay with it.
//
// One predicate now answers "may we offer Apple Pay?" for both surfaces.
//
// NOT VERIFIED BY THESE TESTS: that the wallet sheet itself completes a
// payment. That needs real Apple hardware on a registered domain. These pin the
// ELIGIBILITY GATE only — specifically that the advertisement cannot be shown
// anywhere the button would not render.
// ---------------------------------------------------------------------------

// The gate reads the registered-host list from the environment at call time.
// Without a configured list every host is unregistered, which would make these
// tests pass for the wrong reason.
const PREVIOUS_DOMAINS = process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS;
beforeAll(() => {
  process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS = "vantalabsresearch.com";
});
afterAll(() => {
  process.env.NEXT_PUBLIC_APPLE_PAY_DOMAINS = PREVIOUS_DOMAINS;
});

const APPLE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";

/** Every gate open. Individual tests close exactly one. */
const eligible: ApplePayEnvironment = {
  enabled: true,
  userAgent: APPLE_UA,
  hostname: "vantalabsresearch.com",
  hasApplePaySession: true,
  supportsVersion: true,
  canMakePayments: true,
};

describe("Apple Pay may be offered only when every gate is open", () => {
  it("offers it when the platform, wallet and host all check out", () => {
    expect(canOfferApplePay(eligible)).toBe(true);
  });

  it("refuses when express checkout is switched off", () => {
    expect(canOfferApplePay({ ...eligible, enabled: false })).toBe(false);
  });

  it("refuses on a non-Apple platform — the reproduced desktop-Chrome case", () => {
    expect(canOfferApplePay({ ...eligible, userAgent: CHROME_UA })).toBe(false);
  });

  it("refuses on an unregistered host, apex vs www included", () => {
    // The live risk called out in express-checkout.ts: these are two separate
    // Apple registrations, and only the exact serving host validates.
    expect(canOfferApplePay({ ...eligible, hostname: "www.vantalabsresearch.com" })).toBe(false);
    expect(canOfferApplePay({ ...eligible, hostname: "127.0.0.1" })).toBe(false);
  });

  it("refuses when the browser exposes no ApplePaySession", () => {
    expect(canOfferApplePay({ ...eligible, hasApplePaySession: false })).toBe(false);
  });

  it("refuses on a device too old for the PassKit version the sheet needs", () => {
    expect(canOfferApplePay({ ...eligible, supportsVersion: false })).toBe(false);
  });

  it("refuses when the wallet has no card provisioned", () => {
    expect(canOfferApplePay({ ...eligible, canMakePayments: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// The old pill gate was `EXPRESS_CHECKOUT_ENABLED` alone. Modelled here so the
// tests above are proven to discriminate: the legacy gate says "advertise" in
// exactly the states where the real button does not render.
// ---------------------------------------------------------------------------
describe("negative control: the old pill gate advertised what it could not offer", () => {
  const legacyPillGate = (env: ApplePayEnvironment) => env.enabled;

  it("the legacy gate advertises Apple Pay on desktop Chrome; the shared gate does not", () => {
    const desktop = { ...eligible, userAgent: CHROME_UA };

    expect(legacyPillGate(desktop)).toBe(true);
    expect(canOfferApplePay(desktop)).toBe(false);
  });

  it("the legacy gate advertises Apple Pay on an unregistered host; the shared gate does not", () => {
    const wrongHost = { ...eligible, hostname: "www.vantalabsresearch.com" };

    expect(legacyPillGate(wrongHost)).toBe(true);
    expect(canOfferApplePay(wrongHost)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACT — the two surfaces must read the SAME gate.
// ---------------------------------------------------------------------------
const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8");

describe("source contract: one gate, both surfaces", () => {
  const checkout = read("src/app/checkout/page.tsx");
  const button = read("src/components/express-apple-pay-button.tsx");

  it("the accepted-methods pill no longer keys off the bare feature flag", () => {
    expect(checkout).not.toMatch(
      /EXPRESS_CHECKOUT_ENABLED \? "Apple Pay · Visa · Mastercard · Amex · Discover"/,
    );
  });

  it("the pill reads the shared eligibility hook", () => {
    expect(checkout).toMatch(/useApplePayOffered/);
  });

  it("the button reads the same shared hook rather than its own copy", () => {
    expect(button).toMatch(/useApplePayOffered/);
    // The old private duplicate of the gate must be gone.
    expect(button).not.toMatch(/const getPlatformSupport = \(\) =>/);
  });
});
