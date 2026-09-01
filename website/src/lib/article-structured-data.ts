// ---------------------------------------------------------------------------
// WHAT A RESEARCH ARTICLE TELLS GOOGLE IT IS.
//
// The research library is this site's best near-term shot at ranking for
// anything other than the brand name. Product pages compete with seven
// similarly-named peptide vendors and a large compliance-software company for
// the word "Vanta"; "how to read a certificate of analysis" competes with
// almost nobody. Those pages shipped with no structured data at all, so Google
// had nothing saying they were articles rather than more storefront.
//
// The publisher reference is the point of the exercise. Pointing at the
// Organization node's @id makes each article corroborate the SAME entity the
// homepage and all ~40 product pages declare, instead of floating unattached.
// In a namespace this crowded, every node that resolves to one entity is a
// vote for which "Vanta Labs" is real.
// ---------------------------------------------------------------------------

import { breadcrumbList } from "@/lib/breadcrumbs";

export type ArticleLike = {
  slug: string;
  title: string;
  excerpt: string;
  updated: string;
};

/**
 * `updated` is operator-entered and defaults to the bare year "2026" when
 * nobody has set one. Google wants ISO 8601, and a bare year expanded into
 * "2026-01-01" would be a date this site invented — so a value that is not
 * already a full date is omitted rather than guessed. Missing beats wrong.
 */
export function articleDateModified(updated: string | undefined): string | undefined {
  if (!updated) return undefined;
  const trimmed = updated.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) return undefined;
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

export function articleSchema({
  article,
  siteUrl,
  organizationId,
}: {
  article: ArticleLike;
  siteUrl: string;
  organizationId: string;
}) {
  const url = `${siteUrl}/research/${article.slug}`;
  const dateModified = articleDateModified(article.updated);

  return {
    "@context": "https://schema.org/",
    "@type": "Article",
    headline: article.title,
    description: article.excerpt,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    // Both roles are the same entity here — this is a first-party library, not
    // a syndicated feed with outside contributors.
    publisher: { "@id": organizationId },
    author: { "@id": organizationId },
    ...(dateModified ? { dateModified } : {}),
    isAccessibleForFree: true,
  };
}

/** Home › Research › <article>. */
export function articleBreadcrumbs({ article, siteUrl }: { article: ArticleLike; siteUrl: string }) {
  return breadcrumbList([
    { name: "Home", url: `${siteUrl}/` },
    { name: "Research", url: `${siteUrl}/research` },
    { name: article.title, url: `${siteUrl}/research/${article.slug}` },
  ]);
}
