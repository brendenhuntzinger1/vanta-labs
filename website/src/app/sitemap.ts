import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-identity";
import { getCatalogProducts } from "@/lib/catalog";
import { ARTICLE_SLUGS } from "@/lib/articles";
import { POLICY_SLUGS } from "@/lib/legal-content";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const staticRoutes = ["", "/products", "/coa-library", "/membership", "/ambassador", "/partner", "/contact", "/wholesale", "/research"].map((path) => ({
    url: `${base}${path}`,
    changeFrequency: "weekly" as const,
    priority: path === "" ? 1 : 0.7,
  }));

  const articleRoutes: MetadataRoute.Sitemap = ARTICLE_SLUGS.map((slug) => ({
    url: `${base}/research/${slug}`,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  const legalRoutes: MetadataRoute.Sitemap = POLICY_SLUGS.map((slug) => ({
    url: `${base}/legal/${slug}`,
    changeFrequency: "yearly" as const,
    priority: 0.3,
  }));

  // <lastmod> IS THE ONLY ONE OF THESE THREE HINTS GOOGLE ACTS ON.
  //
  // It has said publicly that it ignores <changefreq> and <priority>; what it
  // reads is when a page last changed, to decide what is worth re-crawling.
  // This sitemap carried the two it ignores and omitted the one it uses, so a
  // new product or a price change waited on Google's own guess.
  //
  // ONLY WHERE IT IS TRUE. A lastmod that is always "now" is worse than none —
  // Google detects sitemaps that stamp every URL with the current date and
  // stops trusting the field. Products have a real `updated_at` on the row, so
  // they get one. The static pages, the legal policies and the research
  // articles do not carry a trustworthy date (their `updated` field is free
  // text, defaulting to the string "2026"), so they are left without one
  // rather than given a fabricated one.
  let productRoutes: MetadataRoute.Sitemap = [];
  try {
    const products = await getCatalogProducts();
    productRoutes = (products ?? [])
      .filter((product): product is typeof product & { slug: string } => Boolean(product?.slug))
      .map((product) => {
        const changed = product.updatedAt ? new Date(product.updatedAt) : null;
        return {
          url: `${base}/products/${product.slug}`,
          ...(changed && !Number.isNaN(changed.getTime()) ? { lastModified: changed } : {}),
          changeFrequency: "weekly" as const,
          priority: 0.6,
        };
      });
  } catch {
    // Sitemap still returns static routes if the catalog can't be read.
  }

  return [...staticRoutes, ...articleRoutes, ...legalRoutes, ...productRoutes];
}
