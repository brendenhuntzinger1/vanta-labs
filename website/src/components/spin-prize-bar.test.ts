import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSuppressedRoute } from "@/components/storefront-offers-bar";

/**
 * THE REWARD HAS TO BE VISIBLE WHILE THE BASKET IS STILL BEING BUILT.
 *
 * The cart drawer, /cart and the checkout all carry the prize and its
 * shortfall. The catalogue and the product pages — where the basket is actually
 * built — carried nothing, so somebody who had won a free $119.99 vial with a
 * $100 minimum shopped as though they had won nothing and only met the
 * condition once the basket was settled.
 *
 * Asserted against the source because the suite runs in node with no DOM. What
 * a browser shows is covered by the QA script that drives it.
 */

const SRC = join(process.cwd(), "src");
const BAR = readFileSync(join(SRC, "components", "spin-prize-bar.tsx"), "utf8");
const LAYOUT = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");
const CHECKOUT = readFileSync(join(SRC, "app", "checkout", "page.tsx"), "utf8");

describe("the number it quotes", () => {
  it("prefers the figure the till enforced over its own arithmetic", () => {
    // THE TWO AGREE UNTIL THE PRIZE IS IN THE CART, AND THEN THEY DO NOT. The
    // till gates on what is actually PAID once the prize's own unit has left
    // the paid lines, so two vials at $119.99 read as $227.98 against a $200
    // floor here and $119.99 there — the bar would fall silent at the exact
    // moment the reward was being withdrawn.
    expect(BAR).toContain('typeof offerQuote?.offerShortfallCents === "number"');
    expect(BAR).toContain("offerQuote.offerShortfallCents / 100");
  });

  it("uses the same rule the checkout does, not a second one", () => {
    expect(CHECKOUT).toContain('typeof offerQuote?.offerShortfallCents === "number"');
    expect(BAR).toContain("Math.max(0, pendingOffer.minSubtotalCents / 100 - subtotal)");
    expect(CHECKOUT).toContain("Math.max(0, pendingOffer.minSubtotalCents / 100 - shownSubtotal)");
  });
});

describe("where it may appear", () => {
  it("never on the home page, a payment, or an operator surface", () => {
    // Borrowed rather than restated: the offers bar already writes down which
    // routes a banner has no business on, and two copies of that list would
    // drift.
    expect(BAR).toContain("isSuppressedRoute(pathname)");
    for (const route of ["/", "/checkout", "/pay/abc", "/order/123", "/admin", "/vault", "/partner"]) {
      expect(isSuppressedRoute(route), `${route} is not suppressed`).toBe(true);
    }
  });

  it("stays quiet where the reward is already spelled out", () => {
    expect(BAR).toContain('pathname === "/cart" || pathname === "/spin"');
  });

  it("does appear where the basket is built", () => {
    expect(isSuppressedRoute("/products")).toBe(false);
    expect(isSuppressedRoute("/products/glow-2")).toBe(false);
  });

  it("is mounted once, under the promotions band", () => {
    expect(LAYOUT).toContain("<SpinPrizeBar />");
    expect(LAYOUT.indexOf("<SpinPrizeBar />")).toBeGreaterThan(LAYOUT.indexOf("<StorefrontOffersBar"));
  });
});

describe("what it does before it asks", () => {
  it("claims a prize won on another device, then reads the status", () => {
    // The claim has to come FIRST: /api/offer/status reads the very cookie a
    // second device is missing, so reading before claiming would only ever
    // find a prize this browser already had.
    expect(BAR.indexOf("claimSpinPrizeOnce()")).toBeLessThan(BAR.indexOf('"/api/offer/status"'));
  });

  it("asks nothing of a visitor who could not have a reward", () => {
    // Unconditional, this logs a 401 on the sign-in portal — the first screen
    // of almost every visit. The email grant is included because a win-back
    // recipient browsing without an account is exactly who holds a prize.
    expect(BAR).toContain("if (!signedIn && !emailGrant) return;");
  });

  it("renders nothing at all without a live reward", () => {
    expect(BAR).toContain("if (!pendingOffer) return null;");
  });
});

describe("it is a statement, not an ask", () => {
  it("has no dismiss control", () => {
    // A promotion is an ask and can be declined. This is the shopper's own
    // property, and it disappears by itself when the server stops reporting it.
    expect(BAR).not.toContain("Dismiss");
    expect(BAR).not.toContain("dismissed");
  });

  it("says free only of a product, which is the only reward that needs the word", () => {
    // Otherwise: "your free Free shipping + 15% off".
    expect(BAR).toContain('offer.rewardKind === "free_product" ? `free ${offer.rewardName}`');
  });
});

describe("what it says when the till has not answered", () => {
  // THE FALLBACK IS NOT A SECOND OPINION, IT IS A GAP. offer-quote.ts stores a
  // quote only on `response.ok && data.ok`, so a 500, a cut connection or the
  // first paint leave `offerQuote` null. The gross arithmetic then reads two
  // $119.99 vials against a $200 floor as "over it" — and the bar printed
  // "is applied at checkout" for a reward the till was about to withdraw.
  //
  // That is the exact false success the server figure was added to prevent, so
  // it must not come back through the fallback. The fallback keeps the FIGURE
  // (better than a blank) and loses the CLAIM.
  const OWNERS = [
    ["the storefront prize bar", BAR],
    ["the cart drawer", readFileSync(join(SRC, "components", "cart-drawer.tsx"), "utf8")],
  ] as const;

  for (const [name, source] of OWNERS) {
    it(`${name} says "applied" only on the server's own answer`, () => {
      expect(source).toContain("const offerApplied = serverShortfall !== null && serverShortfall <= 0;");
    });
  }
});
