import type { MetadataRoute } from "next";

function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "http://localhost:3000");
}

export default function robots(): MetadataRoute.Robots {
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
