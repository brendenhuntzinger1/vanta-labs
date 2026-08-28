import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE STAFF SHORTCUT MUST NEVER WIN A TAP AIMED AT A CUSTOMER'S BUTTON.
//
// The /vault link is a 39x24 box at `fixed bottom-2 right-2`, painted at 15%
// opacity. Three of the app's screens put a full-width CTA bar in exactly that
// corner: the product page's Add to Cart, checkout's pay bar, and the account
// dashboard's nav. The shortcut and the bar overlap.
//
// This was fixed once by dropping the shortcut to z-30, beneath those bars'
// z-40/z-50, and that IS correct — while both live in the same stacking
// context. The product page does not: `.vl2-lab-page` carries
// `isolation: isolate` (globals.css) so its decorative `::before` at
// z-index:-2 stays contained. That isolation traps the buy bar's z-50 INSIDE
// the page's own context, and the page itself is z-index:auto at the root — so
// the root-level comparison is auto vs the shortcut's 30, and the shortcut
// wins.
//
// Measured on the harness, 2026-08-28, TikTok WebView at 393x664, on
// /products/cjc-1295-2mg. ADD TO CART occupies 226..373 x 599..648; the
// shortcut occupies 346..385 x 632..656. A tap at (360, 640) is inside the
// button and navigated to /vault, adding nothing to the cart. 27x16px of the
// primary purchase control on every mobile product page.
//
// z-index cannot be trusted for this: it only orders siblings within one
// stacking context, and any future `transform`, `filter`, `opacity` or
// `isolation` on a page wrapper re-opens the hole silently. So the shortcut
// now steps aside entirely whenever a customer CTA bar is mounted, which is a
// statement about the DOM rather than about paint order.
// ---------------------------------------------------------------------------

describe("the /vault staff shortcut yields to customer CTA bars", () => {
  const css = read("src/app/globals.css");
  const layout = read("src/app/layout.tsx");

  const BARS = [
    ["src/components/product-detail-client.tsx", "the product page Add to Cart bar"],
    ["src/app/checkout/page.tsx", "the checkout pay bar"],
    ["src/components/account-dashboard-nav.tsx", "the account dashboard nav"],
  ] as const;

  it("marks every full-width bottom CTA bar with a class the shortcut can see", () => {
    for (const [file, what] of BARS) {
      const source = read(file);
      // The bar must carry the marker on the same element that is fixed to the
      // bottom, or the rule below matches nothing.
      // Matched on the two parts that make it a full-width bottom bar, not on
      // the whole class string — that would break on any unrelated reorder.
      const bar = source
        .split("\n")
        .find((line) => line.includes("vl-bottom-bar") && line.includes("fixed inset-x-0 bottom-0"));
      expect(bar, `${what}: no full-width bottom bar found in ${file}`).toBeTruthy();
      expect(bar, `${what} must carry vl-cta-bar so the shortcut can yield to it`).toContain(
        "vl-cta-bar",
      );
    }
  });

  it("only hides it at the widths where those bars actually render", () => {
    // All three bars are `lg:hidden` — display:none, but still in the DOM. An
    // unscoped :has() therefore matched on a desktop too and hid the shortcut
    // on every product, checkout and account page there: no overlap, no
    // reason, and the machine staff are most likely to be using. Verified at
    // 1440px and 1024px.
    const rule = css.match(/@media \(max-width: 1023px\)[^@]*body:has\(\.vl-cta-bar\)/);
    expect(rule, "the yield rule must be scoped below lg, where the bars exist").toBeTruthy();
  });

  it("hides the shortcut whenever such a bar is on the page", () => {
    expect(layout, "the shortcut needs its own class to be targetable").toContain(
      "vl-staff-shortcut",
    );
    // Presence-based, not paint-based: true regardless of stacking context.
    const rule = css.match(/body:has\(\.vl-cta-bar\)[^}]*\{[^}]*\}/);
    expect(rule, "globals.css must hide .vl-staff-shortcut while a .vl-cta-bar exists").toBeTruthy();
    expect(rule![0]).toContain(".vl-staff-shortcut");
    // display:none removes it from hit-testing outright. pointer-events:none
    // would also work, but leaves a visible-but-dead affordance.
    expect(rule![0]).toMatch(/display:\s*none/);
  });

  it("keeps z-30 as the fallback where :has() is unavailable", () => {
    // Safari <15.4 and Chrome <105 ignore the rule above. There the original
    // ordering still applies and still protects checkout and the account nav,
    // both of which stack normally. Removing it would regress those.
    expect(layout).toMatch(/vl-staff-shortcut[^"]*z-30|z-30[^"]*vl-staff-shortcut/);
  });

  it("still lifts the shortcut clear of the consent banner", () => {
    // The reason it is a .vl-bottom-bar in the first place: being fixed, it
    // cannot be scrolled out from under the banner, so it must move for it.
    expect(layout).toContain("vl-bottom-bar");
    expect(css).toMatch(/body\[data-cookie-banner="true"\] \.vl-bottom-bar/);
  });
});
