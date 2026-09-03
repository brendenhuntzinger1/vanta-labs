import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// "preview" — THE MODE THAT LETS A SHOPPER SEE THEIR OWN GIFT.
//
// A one-time offer's token lives in an httpOnly cookie so the page cannot read
// it, which also means the page cannot price it. The cart and the checkout
// summary therefore showed full shipping and no free vial on orders the server
// was about to price with neither. The fix was NOT to teach the browser the
// offer rules — that is a second pricing implementation, and the store already
// carries the "Altered total detected" guard because a hand-written Buy-X-Get-Y
// loop in the cart drifted from the one in quote-order.ts. The fix was to ask
// quoteOrder and render its answer.
//
// This mode is what makes that askable before the shopper has finished the
// form, so these assertions are about the properties that make it SAFE:
//
//   * it prices shipping and tax (unlike address_optional, which zeroes both);
//   * it does not demand the state that destination_only demands, because that
//     rule protects a real charge from dodging tax in a nexus state and a
//     preview places no order;
//   * it still refuses a country the store does not ship to, so no preview ever
//     quotes invented postage;
//   * it grants nothing — the same as every other mode, since quoteOrder takes
//     no lock and writes nothing anywhere.
//
// Read from source rather than executed: quoteOrder reaches Supabase, the
// catalogue and the profit engine on every call, and the behaviour that matters
// here is structural. The end-to-end proof that the numbers are right lives in
// scripts/qa-offer-checkout-journey.mjs, which reads the rendered dollars off
// two browsers and compares them to the order row.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");
const ROUTE = readFileSync(join(process.cwd(), "src/app/api/checkout/quote/route.ts"), "utf8");

/** Comments explain the rules; only the code obeys them. Assertions about what
 *  the endpoint DOES have to read the code alone — the prose in this file says
 *  "no token" more than once, and matching that would pass on the wording. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROUTE_CODE = withoutComments(ROUTE);
const SOURCE_CODE = withoutComments(SOURCE);

describe("quoteOrder preview mode", () => {
  it("is a declared mode", () => {
    expect(SOURCE).toMatch(/export type QuoteMode =[^;]*"preview"/);
  });

  it("prices shipping and tax, unlike address_optional", () => {
    // destinationKnown gates both. Only address_optional opts out of it, so
    // preview gets a real shipping figure and a real tax resolution.
    expect(SOURCE).toContain('const destinationKnown = input.mode !== "address_optional"');
  });

  it("does not require a state, so a half-filled form still previews", () => {
    // The dispatch must NOT route preview into validateDestination, which
    // throws "Please select the state for your shipping address." A shopper who
    // has not reached the state selector still needs to see their gift.
    const dispatch = SOURCE_CODE.slice(SOURCE_CODE.indexOf('if (input.mode === "full")'), SOURCE_CODE.indexOf("const sanitizedItems"));
    expect(dispatch).toContain('} else if (input.mode === "preview") {');
    const previewBranch = dispatch.slice(dispatch.indexOf('input.mode === "preview"'));
    expect(previewBranch).not.toContain("validateDestination");
    expect(previewBranch).toContain("isShippableCountry");
  });

  it("still refuses a country the store does not ship to", () => {
    const previewBranch = SOURCE_CODE.slice(SOURCE_CODE.indexOf('} else if (input.mode === "preview") {'), SOURCE_CODE.indexOf("const sanitizedItems"));
    expect(previewBranch).toMatch(/if \(!isShippableCountry\(input\.customer\.country\)\)/);
    expect(previewBranch).toContain("We currently ship only to the United States and Canada.");
  });
});

describe("the preview endpoint", () => {
  it("refuses without an offer cookie, so it changes nothing for other shoppers", () => {
    expect(ROUTE).toContain("const token = readOfferCookie(request)");
    expect(ROUTE).toMatch(/if \(!token\) return declined\("no_offer"\)/);
  });

  it("prices through quoteOrder rather than computing anything itself", () => {
    expect(ROUTE_CODE).toContain("await quoteOrder({");
    expect(ROUTE_CODE).toContain('mode: "preview"');
    // No price arithmetic anywhere in the route: every figure it returns is read
    // straight off the quote. A percentage or a shipping rule reimplemented here
    // is exactly the drift this whole design exists to prevent.
    expect(ROUTE_CODE).not.toMatch(/\*\s*0?\.\d/);
    expect(ROUTE_CODE).not.toMatch(/\/\s*100\b/);
  });

  it("never returns the token or the address the offer is bound to", () => {
    // Anchored on the SUCCESS body. The first NextResponse.json in the file is
    // declined()'s refusal, and slicing from there would cover the whole module.
    const response = ROUTE_CODE.slice(ROUTE_CODE.indexOf("ok: true,"));
    expect(response).not.toMatch(/\btoken\b/);
    expect(response).not.toMatch(/\bemail\b/);
    // The offer is described by kind and wording only.
    expect(response).toContain("rewardKind: quote.appliedOffer.rewardKind");
    // assumedBoundEmail is a boolean about WHOSE address was priced, never the
    // address itself — the one place the two could be confused.
    expect(response).toContain("assumedBoundEmail,");
  });

  it("answers a pricing refusal instead of failing the page", () => {
    // A summary that blanks because a preview timed out is worse than a summary
    // one request behind, so every path returns 200 with a reason.
    expect(ROUTE).toContain('return declined("not_priceable")');
    expect(ROUTE).toMatch(/function declined\(reason: string\) \{[\s\S]*NextResponse\.json\(\{ ok: false, reason \}\)/);
  });

  it("is rate limited, because it runs a full pricing pass on every call", () => {
    expect(ROUTE).toMatch(/checkRateLimit\(`checkout-quote:\$\{ip\}`/);
  });
});
