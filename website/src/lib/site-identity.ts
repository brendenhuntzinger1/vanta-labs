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
export function organizationId(): string {
  return `${siteUrl()}/#organization`;
}

/** The entity name. Search engines. */
export const BRAND_LEGAL_NAME = "Vanta Labs Research";

/** The visual brand. Customers. */
export const BRAND_SHORT_NAME = "Vanta Labs";

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
    // The one contact detail this site actually publishes — it is in the footer
    // of all 111 public URLs. Nothing else is asserted: there is no published
    // address, phone number, founding date or social profile anywhere on this
    // site, and inventing them to fill out the schema is structured-data spam
    // that Google penalises rather than rewards.
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
