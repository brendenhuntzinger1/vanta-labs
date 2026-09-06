import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-identity";
import { ARTICLE_SLUGS } from "@/lib/articles";
import { POLICY_SLUGS } from "@/lib/legal-content";
import { isPublicPath } from "@/lib/access-policy";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE SITEMAP IS DERIVED FROM THE ACCESS POLICY, NOT REMEMBERED ALONGSIDE IT.
//
// It used to be a hand-kept list, curated once when /products and /coa-library
// were the only gated prefixes. The very next change — closing the default, so
// that a path is public only if access-policy.ts names it — moved four more
// URL classes behind the wall and did not touch this file. Measured against the
// harness build afterwards, 7 of the 17 URLs advertised here answered 307 to
// /account/login:
//
//     /                             307  -> /account/login?next=%2F
//     /membership                   307
//     /research                     307
//     /research/<four articles>     307  (one per article)
//
// The file's own comment already said why that is the one thing a sitemap must
// never do — "Listing a URL we will not serve teaches Google that this sitemap
// is unreliable" — and it was doing it, because the rule lived in one file and
// the list of URLs lived in another.
//
// So every candidate below is now filtered through isPublicPath(), the SAME
// predicate middleware.ts enforces. Gate a route and it leaves the sitemap on
// the same deploy, with no second edit and nobody having to remember. Open one
// and it returns.
//
// WHAT THIS DOES NOT DO: it does not decide what is public. The home page and
// the research library are behind the account wall by the owner's deliberate
// decision (see the header of lib/access-policy.ts, which states the indexing
// cost of that in as many words). This file only stops advertising doors that
// are locked.
//
// NO PRODUCT URLS, and no import that could reintroduce them. A product URL is
// a compound name, so publishing the catalogue here would hand an anonymous
// reader the exact thing the gate withholds — and a public sitemap is the
// easiest possible way to enumerate a store.
// ---------------------------------------------------------------------------

/** Everything this site would offer a crawler if nothing were gated. */
function candidates(): Array<{ path: string; changeFrequency: "weekly" | "monthly" | "yearly"; priority: number }> {
  return [
    ...["", "/membership", "/ambassador", "/partner", "/contact", "/wholesale", "/research"].map((path) => ({
      path,
      changeFrequency: "weekly" as const,
      priority: path === "" ? 1 : 0.7,
    })),
    ...ARTICLE_SLUGS.map((slug) => ({
      path: `/research/${slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
    ...POLICY_SLUGS.map((slug) => ({
      path: `/legal/${slug}`,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  return candidates()
    // "" is the home page, and isPublicPath speaks in pathnames, so ask it about "/".
    .filter((entry) => isPublicPath(entry.path === "" ? "/" : entry.path))
    .map((entry) => ({
      url: `${base}${entry.path}`,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
    }));
}
