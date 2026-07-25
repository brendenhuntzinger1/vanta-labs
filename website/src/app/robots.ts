import type { MetadataRoute } from "next";

function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "https://vantalabsresearch.com");
}

export default function robots(): MetadataRoute.Robots {
  // Non-production deployments (Vercel preview/staging, local dev) disallow the
  // entire site so a preview URL is never crawled or indexed.
  if (process.env.VERCEL_ENV !== "production") {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Keep private/admin and transactional surfaces out of the index.
        disallow: ["/admin", "/vault", "/api", "/account", "/checkout", "/cart", "/pay", "/maintenance", "/r/"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
