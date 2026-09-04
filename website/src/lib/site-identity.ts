// ---------------------------------------------------------------------------
// WHO THIS SITE SAYS IT IS, IN ONE PLACE.
//
// The business trades as "Vanta Labs" and owns vantalabsresearch.com, but its
// entity name — the thing a person types into Google — is "Vanta Labs Research".
// Before this file existed that exact phrase appeared nowhere in the rendered
// site: not in the title, the description, og:site_name, the Organization
// schema, the WebSite schema, or the footer. The domain name was the only place
// the full brand was written down, and a domain is the weakest signal a site
// can offer about its own identity.
//
// That matters more here than it would for most brands, because "Vanta Labs" is
// not a name this business holds alone. A well-known compliance SaaS company
// owns the "Vanta" entity in Google's knowledge graph outright, and at least two
// other peptide vendors publish under near-identical names — one of them titled
// literally "Vanta Labs & Research". Emitting only the short brand put this site
// into a three-way tie it had no way to win. Emitting the full entity name is
// what breaks the tie.
//
// The split, which is deliberate:
//
//   * BRAND_LEGAL_NAME is the ENTITY. It belongs in structured data, in
//     og:site_name, in the homepage title and in the footer — the places search
//     engines read to decide what a site is called.
//   * BRAND_SHORT_NAME is the VISUAL brand. It stays in the logo, the age gate,
//     the header and the per-page title suffix, because that is what the
//     business actually calls itself to customers.
//
// Internal page titles keep the short suffix on purpose. Repeating the full
// entity name on all 111 URLs would put every page in competition with the
// homepage for the one query the homepage should own, and reads as keyword
// stuffing to boot. Entity clarity is carried by the schema and og:site_name,
// which is where it belongs.
// ---------------------------------------------------------------------------

/**
 * The canonical host, without a trailing slash so callers can join paths.
 *
 * The fallback is www, NOT the apex. In production the apex 308-redirects to
 * www, so an apex fallback would have pointed every canonical, every sitemap
 * entry and the robots.txt sitemap line at a URL that redirects — telling Google
 * the real page lives somewhere it then has to be bounced away from. The env var
 * is set correctly in production today; this makes the code correct if it is
 * ever unset, rather than silently degrading to a redirect chain.
 */
export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "https://www.vantalabsresearch.com";
}

/** The homepage, with the trailing slash schema.org and canonicals expect. */
export function homeUrl(): string {
  return `${siteUrl()}/`;
}

/** Stable node id, so WebSite and Organization resolve to ONE entity. */
/**
 * An image URL a crawler is actually allowed to index.
 *
 * PRODUCT IMAGES ARE STORED IN SUPABASE STORAGE, AND SUPABASE SERVES THEM WITH
 * `X-Robots-Tag: none`. Google's own documentation defines that as "equivalent
 * to noindex, nofollow" — so the URL in a Product's `image` property, which is
 * the one REQUIRED property of a merchant listing, pointed at an asset the
 * crawler had been told to ignore. Measured on 2026-09-04, all 36 product
 * images: the Supabase URL carries the header, and the identical bytes served
 * through this site's own optimiser do not.
 *
 * Nothing on screen changes: the visible <img> already goes through
 * `/_next/image`. This routes the STRUCTURED DATA down the same path, so the
 * schema names the copy of the picture that is allowed to be indexed.
 *
 * A path that is already ours is only made absolute — structured data needs an
 * absolute URL, and there is no reason to send our own file through the
 * optimiser twice.
 */
export function indexableImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const base = siteUrl();
  if (url.startsWith("/")) return `${base}${url}`;
  if (url.startsWith(base)) return url;
  // 1200 is already in the page's own srcSet, so this is a cache hit rather
  // than a new render.
  return `${base}/_next/image?url=${encodeURIComponent(url)}&w=1200&q=75`;
}

export function organizationId(): string {
  return `${siteUrl()}/#organization`;
}

/** The entity name. Search engines. */
export const BRAND_LEGAL_NAME = "Vanta Labs Research";

/** The visual brand. Customers. */
export const BRAND_SHORT_NAME = "Vanta Labs";

// ---------------------------------------------------------------------------
// THE PROFILES THIS BUSINESS ACTUALLY OWNS.
//
// `sameAs` is how a site tells Google that the entity described here is the
// same entity as the one behind these accounts. It is the strongest signal
// available for the specific problem this file exists to solve: "Vanta Labs"
// is contested. A compliance SaaS owns the "Vanta" knowledge-graph entity, and
// at least two other peptide vendors publish under near-identical names —
// vantalab.org ("Vanta Labs & Research") and vantalp.com ("Vanta Labs
// Peptides"), both of which currently outrank this site for its own name.
// Schema alone says "we are called X"; sameAs says "and here is the corroborating
// footprint", which is what separates one claimant from another.
//
// EVERY URL HERE WAS CONFIRMED TO RESOLVE TO A LIVE ACCOUNT BEFORE BEING ADDED,
// and that is the rule for anything added later. A sameAs pointing at a dead
// profile is worse than no sameAs at all: it is an unverifiable claim, which is
// the same category of signal as an invented address or a fake rating.
//
// Note on the TikTok handle: it is "officialvantalabs". The near-miss spelling
// "officalvantalabs" (no second "i") is NOT a real account — it returns TikTok's
// "Couldn't find this account" page. Checked, because the two are one keystroke
// apart and the wrong one would have shipped a broken claim.
// ---------------------------------------------------------------------------
export const BRAND_PROFILES = [
  "https://www.instagram.com/vantalabsresearch/",
  "https://www.tiktok.com/@officialvantalabs",
] as const;

/** Per-page title suffix — short brand, see the note above. */
export const TITLE_TEMPLATE = `%s | ${BRAND_SHORT_NAME}`;

export const HOME_TITLE = `${BRAND_LEGAL_NAME} | Premium Research Peptides`;

/**
 * Every claim here is drawn from trust-claims.ts, which is the single source of
 * truth for what this store is allowed to say. "Third-party tested" is the
 * sanctioned SITE-WIDE testing claim; the dispatch promise carries its cutoff
 * and weekday qualifier for the same reason it does everywhere else. No purity
 * figure, no COA claim: both are gated per product and neither is assertable at
 * the site level.
 */
export const HOME_DESCRIPTION =
  `${BRAND_LEGAL_NAME} supplies premium research peptides for laboratory use — third-party tested, with same-day dispatch on in-stock orders placed by 2PM ET.`;

/** Site-wide entity description. Same sourcing rules as HOME_DESCRIPTION. */
export const ORG_DESCRIPTION =
  `${BRAND_LEGAL_NAME} supplies premium research peptides for laboratory use, third-party tested with batch-level documentation.`;

export function organizationSchema() {
  const base = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": organizationId(),
    name: BRAND_LEGAL_NAME,
    alternateName: BRAND_SHORT_NAME,
    url: homeUrl(),
    logo: `${base}/images/vanta-logo.png`,
    description: ORG_DESCRIPTION,
    // Corroborating profiles — see BRAND_PROFILES. Emitted only when the list
    // is non-empty, so removing every profile removes the property rather than
    // leaving an empty array, which asserts "this entity has no presence".
    ...(BRAND_PROFILES.length > 0 ? { sameAs: [...BRAND_PROFILES] } : {}),
    // The one contact detail this site actually publishes — it is in the footer
    // of all 111 public URLs. Still nothing else is asserted: there is no
    // published address, phone number or founding date anywhere on this site,
    // and inventing them to fill out the schema is structured-data spam that
    // Google penalises rather than rewards. The sameAs list above is the one
    // addition, and it is held to the same standard — every entry verified live
    // rather than assumed.
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: "support@vantalabsresearch.com",
      availableLanguage: "English",
    },
  };
}

export function webSiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl()}/#website`,
    name: BRAND_LEGAL_NAME,
    alternateName: BRAND_SHORT_NAME,
    url: homeUrl(),
    // Reference, not a second copy. Two nodes describing the same company with
    // duplicated properties is how a site ends up with two competing entities.
    publisher: { "@id": organizationId() },
  };
}
