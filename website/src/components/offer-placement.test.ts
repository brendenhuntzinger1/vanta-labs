import { describe, expect, it } from "vitest";
import { requiresAccount } from "@/lib/access-policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * The file with its comments removed.
 *
 * Every "must not contain X" assertion below is about what the code DOES, and
 * each one was written first against the raw source and failed immediately —
 * on the comment explaining the very rule it was checking. A note saying
 * `startsWith("/")` is true of every path is not a prefix match; a paragraph
 * weighing localStorage against sessionStorage is not a use of localStorage.
 * Stripping comments is what makes a negative assertion mean anything here.
 */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
const bar = read("src/components/storefront-offers-bar.tsx");
const modal = read("src/components/storefront-offer-modal.tsx");
const layout = read("src/app/layout.tsx");
const css = read("src/app/globals.css");
const format = read("src/lib/storefront-offer-format.ts");

// ---------------------------------------------------------------------------
// WHERE A PROMOTION MAY SPEAK, AND WHERE IT MAY NOT.
//
// The store owner's rule, and it is a standing one rather than a decision about
// any single sale: the home page is brand-only. No band, no card, no coupon, no
// seasonal dressing — for Labor Day and for every campaign after it. Promotions
// begin where shopping begins, which is the catalogue.
//
// Both halves are route rules rather than flags on a campaign, because a flag
// would have to be remembered and set again on the next sale. A route rule is
// true by default.
//
// Verified in the browser at 390x844 and 1440x900 with a live promotion: the
// home page renders neither surface, /products renders both, and turning the
// promotion off in admin removes both from every route.
// ---------------------------------------------------------------------------
describe("the home page carries no promotion, ever", () => {
  it("suppresses the offers bar on the home page by route", () => {
    const fn = bar.slice(bar.indexOf("export function isSuppressedRoute"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, "the home page must be named in the suppression rule")
      .toMatch(/pathname === "\/"/);
  });

  it("matches the home page EXACTLY, never by prefix", () => {
    // `startsWith("/")` is true of every path on the site. Written in the
    // prefix form the other entries use, this one rule would silently suppress
    // the bar everywhere and the promotion would simply never appear again —
    // with nothing on screen to say why.
    const fn = code(bar).slice(code(bar).indexOf("export function isSuppressedRoute"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, 'a prefix match on "/" suppresses the entire site')
      .not.toMatch(/startsWith\("\/"\)/);
  });

  it("keeps the card off the home page too, and off the money pages", () => {
    const fn = code(modal).slice(code(modal).indexOf("function isShoppingRoute"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const codeBody = body;
    // An allow-list, not a deny-list: the card appears on the shopping
    // surfaces and nowhere else, so a route added to the site later cannot
    // acquire a popup by default.
    expect(body).toMatch(/pathname === "\/products"/);
    expect(body).toMatch(/pathname\.startsWith\("\/products\/"\)/);
    for (const forbidden of ["/checkout", "/cart", "/admin", '=== "/"']) {
        expect(codeBody, `${forbidden} is not a shopping route`).not.toContain(forbidden);
    }
  });

  it("says nothing while a customer is paying, on either payment path", () => {
    // The hosted payment page lives at BOTH /checkout/pay/[orderId] and
    // /pay/[orderId], plus /pay/mock/[orderId] in the harness. Only the first
    // was caught, by the /checkout prefix — so a customer with an order already
    // written and card details on screen was shown a promotion for something
    // else, which is the one moment this rule exists to prevent.
    const fn = code(bar).slice(code(bar).indexOf("export function isSuppressedRoute"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/startsWith\("\/checkout"\)/);
    expect(body, "/pay/[orderId] is the same flow under a different prefix")
      .toMatch(/startsWith\("\/pay"\)/);
    // And the card is an allow-list of the shopping routes, so it was never on
    // either payment page to begin with — asserted in the test above.
  });

  it("leaves nothing behind above the navigation", () => {
    // THE OWNER ASKED FOR THIS SPECIFICALLY: with cookies already answered the
    // band was the only thing above the header, so removing it must let the
    // header come back up rather than leave its height behind.
    //
    // It does, and by construction rather than by luck. The header is `fixed`
    // and is made `static` ONLY while an in-flow bar is present, via :has() —
    // so with no bar the rule does not match and the header is fixed at the top
    // again. Nothing reserves the bar's height anywhere: it has no wrapper, no
    // spacer, and no height custom property, and <body> is a flex column with
    // no `gap`, so a removed child collapses to nothing.
    //
    // Measured on the harness with consent accepted, at 390x844 and 1440x900:
    // nav top 0, position fixed, hero top 0.
    expect(css).toMatch(/:root:has\(\.vl-offer-bar\) \.vl2-nav \{\s*[^}]*position: static/);
    expect(css, "the bar must not reserve height for itself")
      .not.toMatch(/\.vl-offer-bar \{[^}]*(?:min-)?height:/);
    expect(layout, "a wrapper around the bar could hold a gap open")
      .toMatch(/<StorefrontOffersBar offers=\{offers\} \/>/);
  });
});

// ---------------------------------------------------------------------------
// THE CARD AND THE BAND SAY THE SAME THING, BECAUSE THEY ARE THE SAME THING.
// ---------------------------------------------------------------------------
describe("the popup cannot advertise what the band does not", () => {
  it("is handed the one array the layout resolved", () => {
    // Not a second call to getStorefrontOffers, and not a fetch of its own: the
    // same objects the bar receives, already filtered by the dismissal cookie.
    // Two lookups of the same idea is how two surfaces come to disagree.
    expect(layout).toMatch(/<StorefrontOffersBar offers=\{offers\} \/>/);
    expect(layout).toMatch(/<StorefrontOfferModal offers=\{offers\} \/>/);
    expect(modal, "the card must not resolve offers for itself")
      .not.toContain("getStorefrontOffers");
    expect(modal, "the card must not fetch offers for itself").not.toContain("fetch(");
  });

  it("applies the same standing-offer filter the bar does", () => {
    // Free shipping and quantity pricing are always true. A card announcing
    // them is an interruption that tells the customer nothing, and it would
    // appear on days when no sale is running at all.
    expect(bar).toMatch(/live\.filter\(\(o\) => !o\.standing\)/);
    expect(modal).toMatch(/offers\.find\(\(o\) => !o\.standing\)/);
  });

  it("branches on the field that decides whether a code exists", () => {
    // `code` and `automaticNote` are documented as mutually exclusive on the
    // offer itself, so this is the offer's own answer rather than a guess made
    // per surface.
    expect(format).toMatch(/code: string \| null;/);
    expect(format).toMatch(/automaticNote: string \| null;/);
    // The bar's rule, and the card's, written the same way.
    expect(bar).toContain("if (!offer.code)");
    expect(modal).toMatch(/\{offer\.code \? \(/);
    expect(modal, "an automatic offer says so in words")
      .toMatch(/vl-offer-modal-auto[^]*offer\.automaticNote/);
  });

  it("gives a real copy control to a code, and none to an automatic offer", () => {
    // A copy button with nothing to copy teaches a customer to hunt for
    // something to type that does not exist. Browser-verified both ways on the
    // harness: with a coupon live the button copied HARNESS10 to the clipboard
    // and reported COPIED; with Buy 2 Get 1 live there was no button at all and
    // the card read "Applied automatically at checkout".
    expect(modal).toContain("navigator.clipboard.writeText(offer.code)");
    expect(modal).toMatch(/copied \? "Copied" : "Copy code"/);
    // The copy control lives inside the `offer.code` branch, so it cannot be
    // rendered for an offer that has no code.
    const branch = modal.slice(modal.indexOf("{offer.code ? ("), modal.indexOf("</>"));
    expect(branch).toContain("vl-offer-modal-code");
  });
});

// ---------------------------------------------------------------------------
// IT IS SHOWN ONCE. THE KEY IS THE OFFER, NOT THE POPUP.
// ---------------------------------------------------------------------------
describe("the popup is not a nag", () => {
  it("keys its dismissal on the offer, so a new sale is free to appear", () => {
    // A boolean "seen the popup" flag would mean the next sale never announces
    // itself. offerId is derived from the offer's own terms — and, when a
    // seasonal campaign is dressing it, from the campaign id too — so changing
    // the promotion mints a new key.
    expect(modal).toContain("offerTag(offer.id)");
    expect(format, "the id must be content-derived for this to hold")
      .toMatch(/export function offerId/);
  });

  it("remembers for the visit, not for a year", () => {
    // The BAR's dismissal is a year-long cookie, and that is right for a
    // ribbon someone waved away. A modal is not: remembering it that long means
    // a customer returning during the same sale never learns it is running.
    expect(modal).toContain("window.sessionStorage");
    expect(code(modal), "a cookie would outlive the visit").not.toContain("document.cookie");
    expect(code(modal), "localStorage would outlive the visit").not.toContain("localStorage");
  });

  it("decides during render rather than after it", () => {
    // Read as an external store, not read in an effect that then calls
    // setState — which is a cascading render, and which this project's lint
    // rules reject outright. It also means the card is never mounted and then
    // withdrawn.
    expect(modal).toContain("useSyncExternalStore");
    expect(modal).toMatch(/const open = Boolean\(/);
  });

  it("cannot reach anyone who has not been admitted", () => {
    // It used to subscribe to the old overlay's context and wait for it. That
    // overlay is gone, and the guarantee is stronger without it: the modal only
    // renders on shopping routes, and every shopping route now requires an
    // account at the middleware, so an unadmitted visitor never receives the
    // document this could mount in. Promotions leaking to signed-out visitors
    // is exactly the defect that closed the default — see access-policy.ts.
    expect(modal).toMatch(/isShoppingRoute\(pathname\)/);
    expect(modal).not.toContain("useAccessGranted");
    // And the routes it considers "shopping" must all be behind the wall.
    for (const route of ["/", "/products", "/cart", "/checkout"]) {
      expect(requiresAccount(route), `${route} must require an account`).toBe(true);
    }
  });

  it("does not write the body scroll lock", () => {
    // Two components writing body overflow is how a store ends up
    // permanently unscrollable. The card is centred and fixed; the page behind
    // it scrolling costs nothing.
    expect(modal, "the card must not lock body scroll").not.toMatch(/body\.style\.overflow/);
  });

  it("can be closed by keyboard as well as by tapping", () => {
    expect(modal).toMatch(/event\.key === "Escape"/);
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toMatch(/aria-label="Close offer"/);
  });
});

// ---------------------------------------------------------------------------
// ONE DRESS, TWO SURFACES.
// ---------------------------------------------------------------------------
describe("the card wears the band's clothes", () => {
  it("shares the paint rather than copying it", () => {
    // Sixteen ink tokens copied into a second rule is thirty-two edits waiting
    // to drift apart — the bar's own note records learning this at nine values
    // and one theme. Declared once, for both selectors.
    expect(css).toMatch(/\.vl-offer-modal,\n\.vl-offer-bar \{/);
    expect(css).toMatch(/\.vl-offer-modal--americana,\n\.vl-offer-bar--americana \{/);
  });

  it("keeps the bar's selector last in every shared list", () => {
    // offers-bar-is-noticeable.test.ts locates these blocks by searching for
    // the bar's selector followed by an opening brace, which is how every
    // contrast measurement in that file finds its ground. Last in the list the
    // selector still is; first, it would not be, and a dozen tests would fail
    // claiming the band had been deleted.
    for (const sel of [".vl-offer-bar {", ".vl-offer-bar--americana {", ".vl-offer-bar .vl-focus-ring:focus-visible {"]) {
      expect(css, `${sel} must remain findable`).toContain(sel);
    }
  });

  it("uses the fonts the band uses, by the names they actually have", () => {
    // `var(--font-display, …)` was written here for one commit. That variable
    // is declared nowhere, so the card's headline rendered in the Georgia
    // fallback while the band two lines above it was in Fraunces — the same
    // trap the layout's own note records for --font-cormorant-display. A
    // fallback chain makes a missing variable look like a design choice.
    expect(code(css), "--font-display does not exist in this stylesheet")
      .not.toContain("var(--font-display");
    const headline = css.slice(css.indexOf(".vl-offer-modal-headline {"));
    expect(headline.slice(0, 600)).toContain("var(--font-fraunces)");
  });

  it("wears the seasonal flag when the offer carries one", () => {
    // The theme is the current OFFER's, not the store's and not the date's —
    // switching the live promotion in admin switches the dressing with it.
    expect(modal).toMatch(/offer\.theme === "americana"/);
    expect(modal).toMatch(/vl-offer-modal--\$\{offer\.theme\}/);
    expect(modal, "the flag layer is reused verbatim, not reimplemented")
      .toContain('className="vl-offer-flag"');
  });

  it("stops its own entrance for anyone who asked for less motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .vl-offer-modal-scrim"));
    expect(reduced.slice(0, 200)).toMatch(/animation:\s*none/);
  });
});
