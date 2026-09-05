import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-identity";

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
        //
        // /products and /coa-library join them because the catalog now requires
        // an account (see GATED_PREFIXES in middleware.ts). A crawler asking for
        // either is redirected to the login page, so offering them here would
        // only spend crawl budget discovering redirects.
        //
        // ONE RULE FOR EVERY AGENT, and there must never be more than one. This
        // file has a single "*" group on purpose: naming Googlebot, Bytespider
        // or facebookexternalhit separately in order to give them different
        // answers is cloaking, and robots.txt is the most visible possible place
        // to get caught doing it. The catalog is closed to everyone equally.
        //
        // Note what this does NOT do: robots.txt asks a crawler not to fetch a
        // URL, and a well-behaved one complies, but it is a request rather than
        // a control and it does not remove a URL already in an index. The
        // middleware gate is what actually withholds the content; this line
        // just stops us advertising doors that are locked.
        disallow: [
          "/admin",
          "/vault",
          "/api",
          "/account",
          "/checkout",
          "/cart",
          "/pay",
          "/maintenance",
          "/r/",
          "/products",
          "/coa-library",
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
