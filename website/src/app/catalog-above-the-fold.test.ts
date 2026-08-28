import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// NOTHING TO BUY ABOVE THE FOLD.
//
// Every in-app visitor lands on /products — the age gate sends them there,
// because the home page's hero cannot play in a social WebView. So the catalog
// IS the storefront for paid social traffic, and it opened with no product on
// screen.
//
// Measured on the harness, 2026-08-28, new visitor at 375x548 (an iPhone SE
// inside TikTok) and 393x664 (an iPhone 15 inside TikTok). Identical on both:
//
//   consent bar     0..86     86px
//   offers bar     86..135    49px
//   site header   135..204    69px   <- static, because a bar sits above it
//   <main>        204..       +64px of padding
//   h1            294..374
//   trust rail    398..500   102px
//   search/filter
//   FIRST PRODUCT CARD at y=733
//
// Two of those are recoverable without touching either bar.
// ---------------------------------------------------------------------------

describe("the catalog puts a product in front of the visitor", () => {
  const catalog = read("src/app/products/products-client.tsx");
  const css = read("src/app/globals.css");

  it("renders the trust rail AFTER the product grid, not in front of it", () => {
    // The rail is four badges — same-day dispatch, published COAs, purity,
    // support. Good copy, and it was the last thing between a visitor and the
    // thing they came to buy. It costs 102px and it still reads perfectly well
    // underneath the grid, where it answers "should I trust this" AFTER the
    // visitor has found something worth asking about.
    const grid = catalog.indexOf('id="catalog-grid-heading"');
    const rail = catalog.indexOf("<CatalogTrustRail");
    expect(grid, "the product grid must exist").toBeGreaterThan(-1);
    expect(rail, "the trust rail must still be on the page").toBeGreaterThan(-1);
    expect(rail, "the trust rail must come after the product grid").toBeGreaterThan(grid);
  });

  it("drops the header's clearance padding when the header is not floating", () => {
    // `.vl2-nav` is `position: fixed`, so every page's <main> pads its top to
    // clear it. But an in-flow bar above the nav makes the nav `static` (see
    // the rule this mirrors) — it then takes its own height in the document
    // and there is nothing left to clear. The padding stayed anyway: 64px of
    // dead space under two bars that already cost 135px.
    const rule = css.match(
      /:root\[data-consent-pending\] \.vl-nav-clearance[\s\S]{0,220}?\{[^}]*padding-top[^}]*\}/,
    );
    expect(rule, "globals.css must relax .vl-nav-clearance while the nav is in flow").toBeTruthy();
    // Scoped to exactly the conditions that make the nav static, so the
    // padding is untouched whenever the nav really is floating.
    expect(rule![0]).toContain(".vl-consent-bar");
    expect(rule![0]).toContain(".vl-offer-bar");
  });

  it("marks the storefront pages that carry that clearance", () => {
    // Opt-in, not a bare `main` selector: /not-found deliberately pads to
    // pt-40 to centre its message and has no header clearance to give back.
    for (const file of [
      "src/app/products/products-client.tsx",
      "src/components/product-detail-client.tsx",
      "src/app/cart/cart-client.tsx",
      "src/app/checkout/page.tsx",
    ]) {
      const source = read(file);
      const main = source.split("\n").find((l) => l.includes("<main") && l.includes("pt-"));
      expect(main, `${file} has no padded <main>`).toBeTruthy();
      expect(main, `${file} must opt into the clearance rule`).toContain("vl-nav-clearance");
    }
    expect(
      read("src/app/not-found.tsx"),
      "the 404's padding is aesthetic, not header clearance",
    ).not.toContain("vl-nav-clearance");
  });
});
