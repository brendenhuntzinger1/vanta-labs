import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE CART AND THE TILL MUST MEASURE THE SAME FLOOR.
//
// quoteOrder gates a gift on `qualifyingCents` — what the shopper actually PAYS
// once the gift's own unit has been lifted out of the paid lines and the
// winning discount applied. The cart and checkout banners derived their own
// figure instead: `minSubtotalCents/100 - subtotal`, the floor against the
// GROSS basket.
//
// Those agree right up until the shopper already has the prize in their cart,
// and then they disagree completely. Two KLOW at $119.99 is $227.98: the banner
// saw $227.98 against a $200 floor and said nothing, while the till made one of
// them free, saw $119.99 against the same floor, and withdrew the gift. The
// cart promised a reward the total did not contain.
//
// Worse than silent: with the shortfall reading zero and the offer unapplied,
// the checkout fell through to its "bound to a different email address"
// branch — blaming the address for a minimum problem.
//
// Measured on the harness before the fix:
//   prize KLOW (min $200), cart 2x KLOW  -> subtotal $227.98, giftLines [], offer null
//   prize GLP-3 (min $99),  cart 3x GLP-3 -> subtotal $137.97, giftLines [], offer null
//
// These are source assertions rather than a live quote because the pricing pass
// needs a database; qa-wheel-campaign.mjs exercises the same case end to end.
// ---------------------------------------------------------------------------

const QUOTE = readFileSync("src/lib/quote-order.ts", "utf8");
const CHECKOUT = readFileSync("src/app/checkout/page.tsx", "utf8");
const QUOTE_ROUTE = readFileSync("src/app/api/checkout/quote/route.ts", "utf8");

describe("gift floor disclosure", () => {
  it("quoteOrder reports a shortfall rather than leaving it to be guessed", () => {
    expect(QUOTE).toMatch(/offerShortfallCents:\s*QuoteResult\["offerShortfallCents"\]/);
    expect(QUOTE).toMatch(/offerShortfallCents\s*=\s*Math\.max\(0,\s*Math\.round\(floor - qualifyingCents\)\)/);
  });

  it("names the minimum as the reason, instead of reporting null", () => {
    // The old code set `offerWithdrawnBy` only for the welcome-code case and
    // left the floor case as null, so no surface could tell "withdrawn for a
    // reason" apart from "no offer here at all".
    expect(QUOTE).toContain('offerWithdrawnBy = byCode ? "welcome_code" : "minimum"');
    // The union is asserted by MEMBER rather than by exact shape: the point is
    // that "minimum" is a reportable reason beside "welcome_code", not that
    // those two are the only reasons there will ever be. Pinning the literal
    // union made this test fail the moment "unavailable" was added for an
    // out-of-stock reward — a change in the same spirit as this one.
    expect(QUOTE).toMatch(/offerWithdrawnBy:\s*(?:"[a-z_]+"\s*\|\s*)*"minimum"\s*(?:\|\s*"[a-z_]+"\s*)*\|\s*null/);
    expect(QUOTE).toMatch(/offerWithdrawnBy:[^;]*"welcome_code"/);
  });

  it("an out-of-stock reward is reported too, rather than silently dropped", () => {
    // Same failure shape as the floor bug: the reward line returned null, the
    // price was correct, and the customer was told their EMAIL ADDRESS was the
    // problem. Tesamorelin had 5 units against ~6.4 expected winners on the
    // 103-recipient send, so this was reachable on day one.
    expect(QUOTE).toContain('if (offerWithdrawnBy === null) offerWithdrawnBy = "unavailable"');
    expect(CHECKOUT).toContain('offerQuote?.offerWithdrawnBy === "unavailable"');
    // And it must be subtracted from the email branch, or the wrong message wins.
    expect(CHECKOUT).toContain("&& !offerWithdrawnByStock");
  });

  it("every withdrawal reason has its own message, so none falls through to the email branch", () => {
    // offerBlockedByEmail is the LAST branch and the most confident-sounding —
    // it names the shopper's address as the problem. Any reason quoteOrder can
    // report that has no branch of its own lands there and tells them something
    // false. That has now happened twice: once for the minimum, once for stock.
    const reasons = [...QUOTE.matchAll(/offerWithdrawnBy\s*=\s*(?:byCode \?\s*)?"([a-z_]+)"/g)]
      .map((m) => m[1])
      .concat([...QUOTE.matchAll(/offerWithdrawnBy\s*=\s*byCode \? "[a-z_]+" : "([a-z_]+)"/g)].map((m) => m[1]));

    const distinct = [...new Set(reasons)];
    expect(distinct.length).toBeGreaterThan(1);

    for (const reason of distinct) {
      if (reason === "minimum") {
        // The minimum has its own branch keyed off the shortfall figure.
        expect(CHECKOUT).toMatch(/offerShortfall > 0 \?/);
        continue;
      }
      expect(
        CHECKOUT,
        `quoteOrder can report offerWithdrawnBy "${reason}" and the checkout has no branch for it, `
          + "so it falls through to blaming the shopper's email address",
      ).toContain(`offerQuote?.offerWithdrawnBy === "${reason}"`);
    }
  });

  it("measures the shortfall BEFORE the absorbed units are handed back", () => {
    // Restoring the units makes the basket look big enough again — which is
    // precisely the appearance that let the banner say nothing. The assignment
    // must come before the restore loop, or the figure is always zero.
    const assign = QUOTE.indexOf("offerShortfallCents = Math.max(0, Math.round(floor - qualifyingCents))");
    const restore = QUOTE.indexOf("GIVE BACK WHAT THE GIFT BORROWED");
    expect(assign).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(-1);
    expect(assign).toBeLessThan(restore);
  });

  it("carries the figure out through the quote API", () => {
    expect(QUOTE_ROUTE).toContain("offerShortfallCents: quote.offerShortfallCents");
  });

  it("makes the checkout prefer the server's figure over its own arithmetic", () => {
    expect(CHECKOUT).toMatch(/typeof offerQuote\?\.offerShortfallCents === "number"/);
    // The local arithmetic survives only as the fallback for a cart that has
    // not been quoted yet.
    const serverFirst = CHECKOUT.indexOf('typeof offerQuote?.offerShortfallCents === "number"');
    const local = CHECKOUT.indexOf("pendingOffer.minSubtotalCents / 100 - shownSubtotal");
    expect(serverFirst).toBeLessThan(local);
  });

  it("still blames the email only when the floor is genuinely met", () => {
    // offerBlockedByEmail keys off offerShortfall, which now comes from the
    // server. If that guard were dropped, a minimum failure would once again
    // be reported to the shopper as a wrong-address problem.
    expect(CHECKOUT).toMatch(/offerBlockedByEmail[\s\S]{0,200}offerShortfall <= 0/);
  });
});
