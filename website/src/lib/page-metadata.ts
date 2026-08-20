import type { Metadata } from "next";

/**
 * Metadata for a static marketing page.
 *
 * Two things the root layout cannot do for a child page, both of which cost
 * money on paid social:
 *
 *   * a canonical URL, so the same page reached with an ad's tracking
 *     parameters attached does not compete against itself in search;
 *   * a page-specific Open Graph title and description, because the root
 *     layout's values are inherited otherwise and every shared link — catalog,
 *     research, membership — renders an identical preview card.
 *
 * `title` is passed through the root layout's "%s | Vanta Labs" template for
 * the document title, so it is given here without the suffix. The Open Graph
 * title is spelled out in full because crawlers do not apply the template.
 */
/** Shared with the root layout; restated here because of the shallow merge. */
const OG_IMAGE = "/images/og-vanta-labs.png";

export function pageMetadata({
  path,
  title,
  description,
}: {
  /** Site-root-relative path, e.g. "/products". */
  path: string;
  title: string;
  description: string;
}): Metadata {
  const fullTitle = `${title} | Vanta Labs`;
  return {
    title,
    description,
    alternates: { canonical: path },
    // Metadata objects are merged SHALLOWLY: defining `openGraph` here replaces
    // the root layout's object outright rather than extending it. The image has
    // to be restated, or the page inherits a title but loses its picture — a
    // card with no image, which is worse than the generic card it replaced.
    openGraph: {
      type: "website",
      siteName: "Vanta Labs",
      title: fullTitle,
      description,
      url: path,
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Vanta Labs" }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [OG_IMAGE],
    },
  };
}
