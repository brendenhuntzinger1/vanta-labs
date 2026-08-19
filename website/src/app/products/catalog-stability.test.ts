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

describe("the promo banner is resolved by the server, not fetched into the page", () => {
  it("accepts a server-resolved coupon and skips its own fetch when given one", () => {
    const banner = read("src/components/coupon-promo-banner.tsx");
    expect(banner).toContain("initialCoupon");
    // undefined = not server-resolved (keep the old client-fetch behaviour);
    // null = server checked, no live coupon.
    expect(banner).toContain("const serverResolved = initialCoupon !== undefined;");
    expect(banner).toMatch(/if \(serverResolved\) return;/);
  });

  it("is passed down from both server pages that render it", () => {
    for (const file of ["src/app/products/page.tsx", "src/app/products/[slug]/page.tsx"]) {
      const source = read(file);
      expect(source, `${file} should resolve the coupon server-side`).toContain("getStorefrontCoupon");
      // A coupon lookup must never be able to break a product page.
      expect(source, `${file} must tolerate a coupon lookup failure`).toMatch(/getStorefrontCoupon\(\)\.catch/);
    }
    expect(read("src/app/products/products-client.tsx")).toContain("<CouponPromoBanner initialCoupon=");
    expect(read("src/components/product-detail-client.tsx")).toContain("<CouponPromoBanner initialCoupon=");
  });

  it("keeps the prop optional so existing callers are unaffected", () => {
    const detail = read("src/components/product-detail-client.tsx");
    expect(detail).toContain("featuredCoupon?: FeaturedCoupon | null;");
  });
});
