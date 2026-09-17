import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// AN ENDPOINT NOBODY CALLS IS A FEATURE NOBODY HAS.
//
// /api/spin/claim is the whole of the cross-device story. It is careful code —
// session-verified, refuses to stomp an unrelated gift, never fails the page —
// and for its entire life it had exactly one reference in the repository:
//
//     src/lib/email/link-grant.ts:284:  "/api/spin/claim",
//
// an allowlist string. Nothing fetched it. So a prize won on a phone existed
// only in that phone's vl_offer cookie, while the wheel told the customer it
// was "saved to your account … on this device or any other".
//
// That is the kind of defect no unit test catches, because every unit was
// correct. What was missing was an edge between them. This file pins the edge.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip comments, so prose ABOUT a call is not mistaken for the call. */
function code(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

describe("the spin claim endpoint is actually wired up", () => {
  it("something other than an allowlist fetches /api/spin/claim", () => {
    const client = code(read("src/lib/spin/claim-client.ts"));
    expect(client).toContain('fetch("/api/spin/claim"');
    expect(client).toContain('method: "POST"');
    // Cookies are the entire point — a fetch without credentials claims nothing.
    expect(client).toContain('credentials: "same-origin"');
  });

  for (const [label, path] of [
    ["the cart", "src/app/cart/cart-client.tsx"],
    ["the checkout", "src/app/checkout/page.tsx"],
  ] as const) {
    it(`${label} claims a prize before it reads the offer status`, () => {
      const src = code(read(path));

      expect(src, `${path} must import the claim`).toContain('from "@/lib/spin/claim-client"');
      expect(src, `${path} must call the claim`).toContain("claimSpinPrizeOnce()");

      // ORDER IS THE WHOLE FIX. /api/offer/status reads the cookie the claim
      // sets, so reading first answers "no offer" for exactly the person this
      // is for — someone whose prize is on another device.
      const claimAt = src.indexOf("claimSpinPrizeOnce()");
      const statusAt = src.indexOf('fetch("/api/offer/status"');
      expect(claimAt, `${path} must call the claim`).toBeGreaterThan(-1);
      expect(statusAt, `${path} must read the offer status`).toBeGreaterThan(-1);
      expect(claimAt, `${path} must claim BEFORE reading the offer status`).toBeLessThan(statusAt);
    });
  }

  it("the claim is not gated behind already holding an offer", () => {
    // The trap this fell into once already: useOfferQuote looks like the right
    // home for this, but it is gated on `active`, which the cart derives from
    // /api/offer/status, which reads the missing cookie. Claiming there would
    // only ever run for someone who did not need it.
    const quote = code(read("src/lib/offer-quote.ts"));
    expect(quote).not.toContain("claimSpinPrizeOnce");
  });
});

describe("the wheel does not promise more than the claim delivers", () => {
  it("the reveal card says a second device needs a sign-in", () => {
    // /api/spin/claim identifies the customer from the SESSION and takes no
    // email from the request, so an anonymous visitor on a second device cannot
    // be given the prize — by design, because otherwise typing somebody's
    // address would claim theirs.
    // Comment-stripped: the comment beside the fixed copy quotes the old
    // sentence to explain why it went, and prose about a bug is not the bug.
    const wheel = code(read("src/components/spin-wheel.tsx"));
    const claimRoute = code(read("src/app/api/spin/claim/route.ts"));

    expect(claimRoute).toContain("getAuthenticatedUser()");
    expect(wheel).toMatch(/sign in to use it on another device/i);
    expect(wheel).not.toMatch(/on this device or any other/i);
  });
});
