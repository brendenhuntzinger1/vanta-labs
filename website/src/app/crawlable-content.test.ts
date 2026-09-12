import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// FOUR DEFECTS, ONE FAMILY: real content that exists in the code and never
// reaches a crawler, while the page looks perfect in a browser.
//
// The first three were /products shipping a grey skeleton instead of its
// products, the product page mounting its tabs and FAQ answers on click, and
// the age gate hiding the whole storefront from the renderer. These are the
// ones a sweep for more of the same turned up.
// ---------------------------------------------------------------------------

// A fifth case covered the membership landing page's FAQ. That page went with
// the paid membership feature on 2026-09-12; the same click-to-reveal rule is
// still enforced on the product page below.

describe("structured data points at images a crawler may index", () => {
  const identity = read("src/lib/site-identity.ts");
  const product = read("src/app/products/[slug]/page.tsx");

  it("routes product schema images through this site's own origin", () => {
    // Supabase Storage serves every product image with `X-Robots-Tag: none`,
    // which Google documents as equivalent to noindex,nofollow — on the one
    // property a merchant listing REQUIRES. The same bytes through
    // /_next/image carry no such header.
    expect(identity).toContain("export function indexableImageUrl");
    expect(identity).toContain("/_next/image?url=");
    expect(product).toContain("indexableImageUrl(product.image)");
    expect(product).not.toMatch(/image: product\.image \? \[product\.image\] : undefined/);
  });

  it("leaves an image we already serve alone, only absolutising it", () => {
    const fn = identity.slice(identity.indexOf("export function indexableImageUrl"));
    expect(fn.slice(0, 600)).toContain('url.startsWith("/")');
    expect(fn.slice(0, 600)).toContain("url.startsWith(base)");
  });
});

describe("every route carries its own share card", () => {
  it("keeps og:site_name on product pages despite the shallow merge", () => {
    // Metadata objects merge shallowly: defining `openGraph` on a route
    // REPLACES the root layout's. The product route builds its object by hand,
    // so it was the only one of 55 URLs losing siteName.
    const product = read("src/app/products/[slug]/page.tsx");
    const og = product.slice(product.indexOf("openGraph: {"), product.indexOf("twitter: {"));
    expect(og).toContain("siteName: BRAND_LEGAL_NAME");
  });

  it("gives research articles and legal policies their own og:title and og:url", () => {
    // Both returned bare title/description/canonical objects, so all eleven
    // inherited the home page's Open Graph — including an og:url that
    // contradicted the canonical in the same <head>.
    for (const route of ["src/app/research/[slug]/page.tsx", "src/app/legal/[slug]/page.tsx"]) {
      const src = read(route);
      expect(src, `${route} must go through pageMetadata`).toContain("pageMetadata({");
      expect(src).toContain('from "@/lib/page-metadata"');
    }
  });

  it("writes legal descriptions from the policy, not from its own title", () => {
    const legal = read("src/app/legal/[slug]/page.tsx");
    expect(legal).not.toMatch(/description: `\$\{policy\.title\} — Vanta Labs\.`/);
    expect(legal).toContain("summarisePolicy(policy.title, policy.body)");
  });
});

describe("indexableImageUrl handles each kind of URL correctly", () => {
  it("wraps a third-party URL in this site's optimiser", async () => {
    const { indexableImageUrl } = await import("@/lib/site-identity");
    const supabase = "https://mlpimwgkwuqpsvsrlpqv.supabase.co/storage/v1/object/public/product-images/a/b.webp";
    const out = indexableImageUrl(supabase)!;
    expect(out).toContain("/_next/image?url=");
    expect(out).toContain(encodeURIComponent(supabase));
    expect(out.startsWith("http")).toBe(true);
  });

  it("only absolutises a path we already serve", async () => {
    const { indexableImageUrl, siteUrl } = await import("@/lib/site-identity");
    expect(indexableImageUrl("/img/p1.png")).toBe(`${siteUrl()}/img/p1.png`);
    // Already ours and already absolute: left exactly as it is, not optimised twice.
    expect(indexableImageUrl(`${siteUrl()}/img/p1.png`)).toBe(`${siteUrl()}/img/p1.png`);
  });

  it("returns undefined for a product with no image", async () => {
    const { indexableImageUrl } = await import("@/lib/site-identity");
    expect(indexableImageUrl(null)).toBeUndefined();
    expect(indexableImageUrl(undefined)).toBeUndefined();
    expect(indexableImageUrl("")).toBeUndefined();
  });
});
