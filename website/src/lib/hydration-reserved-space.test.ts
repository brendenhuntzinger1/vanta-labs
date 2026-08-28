import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// SPACE THE SERVER CANNOT MEASURE, RESERVED ANYWAY.
//
// The cart lives in localStorage. The server cannot see it, so any block whose
// existence depends on it renders as nothing, appears at hydration, and shoves
// whatever is under it down the page. Two of those blocks sit ABOVE content a
// shopper is already reading:
//
//   /cart      the item list / empty-cart panel, above the Order Summary
//   /checkout  the collapsed mobile summary bar, above the whole form
//
// Measured on the harness at 390x844, before the fix: "Order Summary" painted
// at y=557, then landed at y=745 — a 188px jump, 165ms after first paint, on a
// viewport where it was plainly visible. After: 741 -> 745, 4px.
//
// WHY THESE ARE SOURCE ASSERTIONS AND NOT A CLS BUDGET. Chromium scored that
// 188px jump 0.0000. React replaces these nodes during hydration rather than
// moving them, so no layout-shift entry is ever emitted and every CLS-based
// check passes while the page visibly jumps. A CLS number cannot police this;
// the presence of the reserved block can.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("/cart reserves space for content only the client knows about", () => {
  const cart = source("src/app/cart/cart-client.tsx");

  it("renders a placeholder branch before hydration, not an empty column", () => {
    // The bug was `{isHydrated && items.length === 0 ? empty : items.map(...)}`:
    // pre-hydration that falls to .map over [] and emits nothing at all.
    expect(cart).toContain("{!isHydrated ? (");
    expect(cart).toContain('data-testid="cart-items-placeholder"');
  });

  it("builds the placeholder from the same content it will be replaced by", () => {
    // Not decoration. A hand-sized skeleton measured 178px against the real
    // panel's 184 and left a 10px jump — and would drift again on the next copy
    // edit. Sharing the fragment makes the reserved height correct by
    // construction.
    expect(cart).toContain("const EMPTY_CART_PANEL_CONTENT = (");
    expect(cart.match(/\{EMPTY_CART_PANEL_CONTENT\}/g)).toHaveLength(2);
  });

  it("hides the placeholder copy without collapsing its box", () => {
    // `invisible` is visibility:hidden — it keeps the box, and it also takes the
    // "Browse products" link out of the tab order. `hidden` would reserve
    // nothing, which is the bug.
    expect(cart).toContain('<div className="invisible">{EMPTY_CART_PANEL_CONTENT}</div>');
    expect(cart).toMatch(/data-testid="cart-items-placeholder"/);
  });

  it("keeps the placeholder off the accessibility tree", () => {
    // Otherwise a screen reader meets "No items yet." on a cart that has items —
    // the same false-empty flash the checkout summary's own comment warns about.
    const block = cart.slice(cart.indexOf("{!isHydrated ? ("), cart.indexOf("{EMPTY_CART_PANEL_CONTENT}"));
    expect(block).toContain('aria-hidden="true"');
  });
});

describe("/checkout reserves space for the mobile summary bar", () => {
  const checkout = source("src/app/checkout/page.tsx");

  it("renders a placeholder branch before hydration", () => {
    expect(checkout).toContain('data-testid="checkout-summary-placeholder"');
    expect(checkout).toContain("{!isHydrated ? (");
  });

  it("reserves it at the mobile breakpoint, where the bar actually exists", () => {
    // The real bar is `lg:hidden`, and the only other skeleton on this page
    // lives in an `hidden ... lg:block` aside — i.e. it does not exist at the
    // width where this shift happens.
    const start = checkout.indexOf('data-testid="checkout-summary-placeholder"');
    const block = checkout.slice(Math.max(0, start - 400), start + 400);
    expect(block).toContain("lg:hidden");
    expect(block).toContain("invisible");
  });
});

describe("the consent bar does not overrule the server after hydration", () => {
  const consent = source("src/components/cookie-consent.tsx");

  it("consults the cookie before re-opening the bar", () => {
    // `initiallyOpen` is the server's answer, derived from the cookie. The
    // effect used to run `if (!stored) setVisible(true)` unconditionally, so a
    // visitor with the cookie but no localStorage entry got the bar re-opened
    // after hydration — pushing the page down 52px on desktop, 86px on a phone,
    // which is the exact shift `initiallyOpen` exists to remove.
    expect(consent).toContain("const cookieAnswer = readConsentCookie();");
    expect(consent).toMatch(/if \(!stored\) \{\s*\n\s*if \(cookieAnswer\) \{/);
  });

  it("heals the missing localStorage entry from the cookie", () => {
    // CONSENT_STORAGE_KEY, not STORAGE_KEY: the constant was renamed and moved
    // into lib/cookie-consent-client.ts on main after this test was written.
    // The rename is what made this assertion fail, which is the tripwire doing
    // its job — the behaviour it guards is unchanged.
    expect(consent).toContain("window.localStorage.setItem(CONSENT_STORAGE_KEY, cookieAnswer);");
  });

  it("reads the cookie in one place, so the two branches cannot disagree", () => {
    // The backfill branch used to hand-parse document.cookie separately.
    expect(consent).toContain("function readConsentCookie()");
    expect(consent.match(/document\.cookie\n?\s*\.split/g) ?? []).toHaveLength(1);
  });
});

describe("the public partner page does not ship the Supabase SDK to load", () => {
  const partner = source("src/components/partner-program-landing.tsx");

  it("loads the client dynamically, not as a static import", () => {
    // A static import put the 228 KB supabase-js + auth-js + realtime-js chunk
    // in the entry bundle of a public, indexable page, for two getSession()
    // calls: /partner measured 457.5 KB against 222-233 KB for every comparable
    // route. After: 230.5 KB.
    expect(partner).not.toMatch(/^import\s*\{\s*supabase\s*\}\s*from\s*"@\/lib\/supabase";$/m);
    expect(partner).toContain('await import("@/lib/supabase")');
  });

  it("still reaches the session through that lazy accessor at both call sites", () => {
    expect(partner.match(/await \(await getSupabase\(\)\)\.auth\.getSession\(\)/g)).toHaveLength(2);
  });
});

describe("the offers bar asks for a font that exists", () => {
  const css = source("src/app/globals.css");
  const layout = source("src/app/layout.tsx");

  it("registers Fraunces under the variable the stylesheet actually references", () => {
    // Three rules asked for --font-fraunces while the face was registered as
    // --font-cormorant-display, a name left over from a different font. The
    // variable was defined nowhere, so all three rendered in the Georgia
    // fallback. Verified in the built CSS at the time: grepping the shipped
    // chunks for `--font-fraunces:` returned nothing.
    expect(layout).toContain('variable: "--font-fraunces"');
    expect(css).toContain("var(--font-fraunces)");
  });

  it("has no reference left to the old name, in either file", () => {
    expect(css).not.toContain("cormorant");
    expect(layout).not.toMatch(/variable: "--font-cormorant-display"/);
  });
});
