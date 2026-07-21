import type { MetadataRoute } from "next";
import { getCatalogProducts } from "@/lib/catalog";
import { ARTICLE_SLUGS } from "@/lib/articles";
import { POLICY_SLUGS } from "@/lib/legal-content";

export const dynamic = "force-dynamic";

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "http://localhost:3000";
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const staticRoutes = ["", "/products", "/coa-library", "/membership", "/ambassador", "/partner", "/contact", "/research"].map((path) => ({
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

  let productRoutes: MetadataRoute.Sitemap = [];
  try {
    const products = await getCatalogProducts();
    productRoutes = (products ?? [])
      .map((product: { slug?: string }) => product.slug)
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => ({ url: `${base}/products/${slug}`, changeFrequency: "weekly" as const, priority: 0.6 }));
  } catch {
    // Sitemap still returns static routes if the catalog can't be read.
  }

  return [...staticRoutes, ...articleRoutes, ...legalRoutes, ...productRoutes];
}
