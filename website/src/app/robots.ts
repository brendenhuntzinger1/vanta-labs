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
        //
        // KEPT IN STEP WITH THE WALL. This list was written when /products and
        // /coa-library were the only gated prefixes. Closing the default in
        // access-policy.ts moved the research library behind the same wall and
        // this file was not touched, so we went on inviting crawlers to fetch
        // URLs that answer 307. That costs crawl budget and teaches Google the
        // site is full of redirects.
        //
        // The home page is deliberately NOT listed, and the reason changed on
        // 2026-09-18. It used to be "Disallow: / would block the whole site
        // including the pages that ARE public, and it is gated anyway". The
        // second half is no longer true: "/" is public again (see the entry in
        // access-policy.ts for what gating it cost), so a crawler now gets the
        // real front page. The first half still holds, and it is now the whole
        // reason — the home page is the one URL this site most wants indexed.
        //
        // /sms is likewise absent, and that is also deliberate. It is a
        // legitimate public consent page rather than something to hide: a
        // carrier re-auditing the number should find it, and a customer
        // searching for how to stop the texts should too. It needs no SEO
        // effort, but disallowing it would be the wrong signal about a page
        // whose entire purpose is to be publicly verifiable.
        //
        // sitemap.ts derives its list from isPublicPath() and cannot drift
        // again. This one cannot be derived the same way — it names PREFIXES,
        // and the public set is expressed as exact paths plus prefixes — so
        // robots-matches-the-wall.test.ts checks it instead.
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
          "/research",
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
