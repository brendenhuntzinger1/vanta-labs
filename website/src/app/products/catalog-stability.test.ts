import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// These guard the "the page jumps around while it loads" class of bug.
//
// Measured before the fix: cumulative layout shift of 1.04 on /products (phone)
// and 1.00 on /cart/restore, where anything above 0.25 is classed "poor". The
// cause in every case was a client component that reads useSearchParams —
// which opts it out of server rendering — sitting behind `Suspense
// fallback={null}`. Next renders the FALLBACK into the HTML, so the page
// shipped an empty body, the footer landed at the top of the viewport, and
// everything slammed into place on hydration.
//
// A `null` fallback is the whole bug, and it is one careless edit away from
// coming back, so it is asserted directly.
// ---------------------------------------------------------------------------

describe("pages that opt out of SSR must still reserve their space", () => {
  const cases: Array<{ file: string; page: string }> = [
    { file: "src/app/products/products-client.tsx", page: "the catalog" },
    { file: "src/app/cart/restore/page.tsx", page: "cart recovery" },
    { file: "src/app/partner/page.tsx", page: "the partner landing" },
  ];

  for (const { file, page } of cases) {
    it(`${page} does not ship an empty Suspense fallback`, () => {
      const source = read(file);
      expect(source).toContain("useSearchParams" in {} ? "" : "Suspense");
      expect(source, `${file} must not use fallback={null} — it renders an empty page into the HTML`)
        .not.toContain("Suspense fallback={null}");
    });
  }

  it("the catalog fallback reserves a full screen and shows the loading grid", () => {
    const source = read("src/app/products/products-client.tsx");
    expect(source).toContain("function CatalogFallback");
    expect(source).toMatch(/CatalogFallback[\s\S]{0,400}min-h-screen/);
    // The same skeleton is used by the fallback and by the isLoading branch, so
    // the two cannot drift into showing different things in the same load.
    expect(source).toContain("function CatalogGridSkeleton");
    expect(source.match(/<CatalogGridSkeleton\s*\/>/g) ?? []).toHaveLength(2);
  });
});

// The per-page CouponPromoBanner these used to guard has been replaced by
// StorefrontOffersBar in the root layout. The RISK is unchanged — a promotion
// that arrives after first paint drops a ribbon into the top of the document
// and shoves the page down under the reader — so the guard moves with it
// rather than being deleted along with the component it used to watch.
describe("offers are resolved by the server, not fetched into the page", () => {
  it("the layout resolves offers before it renders", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout, "the layout must await offers so the bar is in the first paint")
      .toMatch(/getStorefrontOffers\(\)/);
    // A promotion lookup must never be able to break every page on the site.
    expect(layout, "the layout must tolerate an offers lookup failure")
      .toMatch(/getStorefrontOffers\(\)\.catch/);
  });

  it("the bar takes its offers as a prop and never fetches them itself", () => {
    const bar = read("src/components/storefront-offers-bar.tsx");
    expect(bar).toContain("offers }: { offers: StorefrontOffer[] }");
    expect(bar, "fetching offers client-side reintroduces the layout shift")
      .not.toMatch(/fetch\(/);
  });

  it("filters dismissals on the SERVER, so the bar never paints and then vanishes", () => {
    // A dismissal held in localStorage can only be read after mount, which
    // means painting the bar and then removing it — the same shift in the
    // other direction. A cookie arrives with the request, so the server sends
    // the final list and nothing moves.
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/OFFERS_DISMISSED_COOKIE/);
    expect(layout).toMatch(/parseDismissed/);
    const bar = read("src/components/storefront-offers-bar.tsx");
    expect(bar, "dismissals must not live in localStorage").not.toMatch(/localStorage/);
  });

  it("resolves offers per request rather than from a cache", () => {
    // Next's data cache is stale-while-revalidate: a coupon switched off was
    // measured still advertised 60s later across three page loads. It also let
    // /products stay statically prerendered, freezing the bar at build time.
    const lib = read("src/lib/storefront-offers.ts");
    expect(lib, "a cached offer read advertises promotions the checkout has stopped honouring")
      .not.toMatch(/^export const getCachedStorefrontOffers = unstable_cache/m);
  });

  it("does not also show the same offer inside the catalog or product page", () => {
    expect(read("src/app/products/products-client.tsx")).not.toContain("<CouponPromoBanner");
    expect(read("src/components/product-detail-client.tsx")).not.toContain("<CouponPromoBanner");
  });
});
