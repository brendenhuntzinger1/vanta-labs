import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-identity";
import { ARTICLE_SLUGS } from "@/lib/articles";
import { POLICY_SLUGS } from "@/lib/legal-content";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  // THE SITEMAP OFFERS ONLY WHAT A SIGNED-OUT CRAWLER CAN ACTUALLY READ.
  //
  // "/products" and "/coa-library" were here and are deliberately gone: both
  // now require an account (GATED_PREFIXES in middleware.ts), so a crawler
  // following either is handed a redirect to the login page. Listing a URL we
  // will not serve teaches Google that this sitemap is unreliable, which is
  // the one thing a sitemap must never be.
  //
  // What remains is the public brand: the home page, the research library, the
  // membership, ambassador, partner, wholesale and contact pages, and the legal
  // policies. That is the whole indexable surface now, and it is the same
  // surface for every visitor.
  const staticRoutes = ["", "/membership", "/ambassador", "/partner", "/contact", "/wholesale", "/research"].map((path) => ({
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

  // NO PRODUCT URLS. This block used to read the catalog and emit a URL per
  // product with a real lastModified. Every one of those URLs is now behind the
  // account gate, so publishing them would hand a crawler — and anyone reading
  // a public sitemap, which is everyone — the complete compound list and the
  // exact thing the gate exists to withhold. The sitemap was, before this
  // change, the single easiest way to enumerate the catalog without an account.
  //
  // getCatalogProducts is no longer imported here at all, so this file cannot
  // regain the ability by accident.

  return [...staticRoutes, ...articleRoutes, ...legalRoutes];
}
