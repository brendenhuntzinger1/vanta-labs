import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE CATALOGUE SHIPPED AN EMPTY GRID, AND NOTHING FAILED.
//
// `/products` is the page whose entire job is to point at every product. It was
// pointing at none of them. `ProductsPageContent` calls `useSearchParams()`,
// which opts a component out of server rendering, so what Next put in the HTML
// was the Suspense fallback — a grey skeleton — and the real cards only existed
// after a `/api/catalog/products` round trip in the browser.
//
// Measured against production on 2026-09-03, counting `href="/products/…"` in
// the HTML a crawler receives:
//
//     /            6 links to products
//     /products    0 links to products   <-- the catalogue
//
// The products were reachable only because sitemap.xml listed them: in the
// phone book, with no sign on the street. Nothing about this is visible to a
// customer, no test covered it, and the page looked perfect in a browser —
// which is why it survived a full launch audit.
//
// These tests hold the fix in place. The fix is not clever: resolve the list on
// the server and hand it down, so the first render already has it.
// ---------------------------------------------------------------------------
describe("the catalogue page ships its products in the HTML", () => {
  const page = read("src/app/products/page.tsx");
  const client = read("src/app/products/products-client.tsx");

  it("resolves the catalogue on the server", () => {
    expect(page).toContain("getStorefrontCatalog");
    expect(page).toMatch(/const initialProducts = await getStorefrontCatalog\(\)/);
    expect(page).toMatch(/<ProductsPageClient initialProducts=\{initialProducts\} \/>/);
  });

  // The important one. The fallback is the ONLY thing a crawler — or anyone
  // before JavaScript runs — sees on this route, so it has to be the real grid
  // rather than a placeholder for it.
  it("renders real product cards in the Suspense fallback, not a skeleton", () => {
    const start = client.indexOf("function CatalogFallback");
    expect(start, "CatalogFallback must exist").toBeGreaterThan(-1);
    const fallback = client.slice(start, client.indexOf("\nexport function ProductsPageClient"));
    expect(fallback).toContain("<ProductCard");
    expect(fallback).toContain("products.length === 0");
    // The skeleton survives for exactly one case: nothing to draw, because the
    // catalogue read failed and the client is about to retry.
    const skeletonAt = fallback.indexOf("<CatalogGridSkeleton");
    const emptyGuardAt = fallback.indexOf("products.length === 0");
    expect(skeletonAt).toBeGreaterThan(emptyGuardAt);
  });

  it("hands the same list to the interactive version, in the same order", () => {
    // The server paints the grid and the client re-renders it a frame later.
    // Two different orders would be a visible shuffle under the reader, so both
    // sides call one shared function rather than each having its own copy of
    // "best sellers first".
    expect(client).toContain('import { inDefaultCatalogOrder } from "@/lib/catalog-order";');
    expect(client).toMatch(/function ProductsPageContent\(\{ initialProducts \}/);
    expect(client).toMatch(/useState<Product\[\]>\(initialProducts\)/);
    expect(read("src/lib/catalog-order.ts")).toContain("export function inDefaultCatalogOrder");
  });

  it("does not re-fetch a catalogue it was already given", () => {
    // Both paths go through the same `unstable_cache`, so a second request is
    // not fresher — just slower, and a second chance to render something
    // different from what the server already drew.
    expect(client).toMatch(/const needsClientLoad = initialProducts\.length === 0;/);
    expect(client).toMatch(/if \(!needsClientLoad\) return;/);
  });

  it("keeps the browser retry for the case it was written for", () => {
    // A catalogue read that failed server-side hands down an empty list, and
    // one retry from the browser can catch a blip the server request landed in.
    expect(page).toMatch(/getStorefrontCatalog\(\)\.catch\(\(\) => \[\]\)/);
    expect(client).toContain('fetch("/api/catalog/products", { cache: "no-store" })');
    expect(client).toContain("setLoadError(true)");
  });

  it("keeps the database out of the browser bundle", () => {
    // `storefront-catalog` reaches Supabase. The shared sort had to move to its
    // own module precisely because importing it from the client component
    // dragged the server client in — caught by the build, but only once it was
    // written that way.
    expect(read("src/lib/storefront-catalog.ts")).toContain('import "server-only";');
    expect(read("src/lib/catalog-order.ts")).not.toContain("@/lib/catalog\"");
    expect(client).not.toContain("@/lib/storefront-catalog");
  });

  it("computes best sellers once, for both callers", () => {
    const route = read("src/app/api/catalog/products/route.ts");
    expect(route).toContain("getStorefrontCatalog");
    // The rule lives in one place; a second copy would drift, and the drift
    // shows up as the grid re-ordering itself on hydration.
    expect(route).not.toContain("getBestSellerSlugs");
  });
});

// ---------------------------------------------------------------------------
// <lastmod> is the only one of the three sitemap hints Google acts on. It has
// said publicly that it ignores <changefreq> and <priority>. This sitemap
// carried both of those and omitted lastmod, so a new product or a price change
// waited on Google's own guess about when to come back.
// ---------------------------------------------------------------------------
describe("the sitemap tells Google when things actually changed", () => {
  const sitemap = read("src/app/sitemap.ts");

  it("emits lastModified for products, from the row's own timestamp", () => {
    expect(sitemap).toContain("lastModified");
    expect(sitemap).toContain("product.updatedAt");
    // Surfaced from the database rather than invented.
    expect(read("src/lib/catalog.ts")).toContain("updated_at");
    expect(read("src/lib/catalog.ts")).toMatch(/updatedAt: row\.updated_at/);
    expect(read("src/lib/catalog-types.ts")).toContain("updatedAt?: string;");
  });

  it("never stamps every URL with the current date", () => {
    // A lastmod that is always "now" is worse than none: Google detects
    // sitemaps that do it and stops trusting the field entirely. Pages without
    // a trustworthy date — the static routes, the legal policies, the research
    // articles, whose `updated` field is free text defaulting to "2026" — are
    // therefore left without one rather than given a fabricated one.
    expect(sitemap).not.toMatch(/lastModified:\s*new Date\(\)/);
    expect(sitemap).not.toMatch(/lastModified:\s*Date\.now\(\)/);
  });

  it("only emits a date it can parse", () => {
    expect(sitemap).toContain("Number.isNaN(changed.getTime())");
  });
});
