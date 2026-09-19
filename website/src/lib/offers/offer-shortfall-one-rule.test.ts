import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONE BASKET MUST NOT GET TWO ANSWERS.
//
// OBSERVED IN THE BROWSER, on the harness at 390x844, one session, one moment,
// two vials of KLOW in the basket ($227.98) against a free-KLOW prize with a
// $200 floor:
//
//   cart drawer : "Free KLOW — applied at checkout"
//   checkout    : "Add $80.01 more to claim your free KLOW."
//
// Both cannot be true and the checkout is the one that charges. The drawer was
// measuring the floor against the GROSS basket, which is the wrong subtotal
// whenever the shopper is also buying the prize product: the reward absorbs one
// of those units, so the qualifying subtotal is $227.98 less the absorbed
// $119.99 vial, and $80.01 short of the floor rather than over it.
//
// That is not an arithmetic detail, it is the difference between "you have a
// free vial" and "you do not", told to somebody about to pay. The server
// already answers it — quoteOrder returns offerShortfallCents from the same
// pass that will charge — and the prize bar and the checkout already ask.
//
// Pinned across all three surfaces rather than only on the one that was wrong:
// the failure was a rule that existed in two places and drifted in the third.
// ---------------------------------------------------------------------------

const read = (...parts: string[]) => readFileSync(join(process.cwd(), "src", ...parts), "utf8");

const SURFACES = [
  ["the cart drawer", read("components", "cart-drawer.tsx")],
  ["the storefront prize bar", read("components", "spin-prize-bar.tsx")],
  ["the checkout summary", read("app", "checkout", "page.tsx")],
] as const;

describe("every surface that states a shortfall asks the server first", () => {
  for (const [name, source] of SURFACES) {
    it(`${name} prefers the quote's own offerShortfallCents`, () => {
      expect(source).toContain('typeof offerQuote?.offerShortfallCents === "number"');
      expect(source).toContain("offerQuote.offerShortfallCents / 100");
    });

    it(`${name} falls back to the gross basket rather than to nothing`, () => {
      // A preview one request behind must show the previous number, never a
      // blank — and on the very first paint there is no quote yet.
      expect(source).toMatch(/Math\.max\(0, pendingOffer\.minSubtotalCents \/ 100 - (shown)?[Ss]ubtotal\)/);
    });
  }
});

describe("the drawer cannot reach for the answer before it has it", () => {
  const drawer = read("components", "cart-drawer.tsx");

  it("computes the shortfall after the quote, not before", () => {
    const quote = drawer.indexOf("const offerQuote = useOfferQuote({");
    const shortfall = drawer.indexOf("const offerShortfall =");
    expect(quote).toBeGreaterThan(-1);
    expect(shortfall, "the shortfall is read before the quote exists").toBeGreaterThan(quote);
  });

  it("uses that one figure for the free-shipping suppression too", () => {
    // offerCoversShipping silences the "you are $X from free shipping" bar once
    // a shipping gift applies. Measured against the wrong subtotal it silenced
    // the bar for a shopper who had not actually unlocked anything.
    const at = drawer.indexOf("const offerCoversShipping");
    expect(at).toBeGreaterThan(drawer.indexOf("const offerShortfall ="));
    expect(drawer.slice(at, at + 260)).toContain("offerShortfall <= 0");
  });
});
