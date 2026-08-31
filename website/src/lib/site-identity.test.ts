import { describe, expect, it } from "vitest";
import {
  BRAND_LEGAL_NAME,
  BRAND_PROFILES,
  BRAND_SHORT_NAME,
  HOME_DESCRIPTION,
  HOME_TITLE,
  organizationSchema,
  siteUrl,
  webSiteSchema,
} from "./site-identity";

/**
 * The branded query "Vanta Labs Research" is a crowded namespace: a compliance
 * SaaS company owns the "Vanta" entity outright, and at least two other peptide
 * vendors publish under "Vanta Labs". Before this file existed the exact phrase
 * appeared NOWHERE in the rendered site — the domain was the only place the
 * brand's full name was written down, which is the weakest signal available.
 *
 * These tests exist so that never silently regresses again.
 */
describe("brand entity naming", () => {
  it("states the full entity name, not just the short visual brand", () => {
    expect(BRAND_LEGAL_NAME).toBe("Vanta Labs Research");
    expect(BRAND_SHORT_NAME).toBe("Vanta Labs");
  });

  it("puts the exact branded phrase in the homepage title", () => {
    expect(HOME_TITLE).toContain("Vanta Labs Research");
  });

  it("puts the exact branded phrase in the homepage description, once", () => {
    expect(HOME_DESCRIPTION).toContain("Vanta Labs Research");
    // Entity clarity, not keyword stuffing.
    expect(HOME_DESCRIPTION.match(/Vanta Labs Research/g)).toHaveLength(1);
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(160);
  });
});

describe("canonical host", () => {
  it("resolves to www, which is the host that actually serves 200", () => {
    // The apex 308-redirects to www in production. A canonical pointing at a
    // redirecting URL is the classic way to make a homepage ambiguous.
    expect(siteUrl()).toBe("https://www.vantalabsresearch.com");
  });

  it("never carries a trailing slash, so joined paths cannot double up", () => {
    expect(siteUrl().endsWith("/")).toBe(false);
  });
});

describe("Organization schema", () => {
  const org = organizationSchema();

  it("is named for the entity, with the visual brand as alternateName", () => {
    expect(org.name).toBe("Vanta Labs Research");
    expect(org.alternateName).toBe("Vanta Labs");
  });

  it("points at the canonical homepage", () => {
    expect(org.url).toBe("https://www.vantalabsresearch.com/");
  });

  it("carries a stable @id so other nodes can reference one entity", () => {
    expect(org["@id"]).toBe("https://www.vantalabsresearch.com/#organization");
  });

  it("claims nothing the site cannot support", () => {
    // No ratings, reviews, addresses, founding dates or phone numbers: none of
    // those are published anywhere on this site, and inventing them is
    // structured-data spam.
    //
    // `sameAs` is deliberately NOT in this list any more. It used to be, on the
    // same reasoning, and that was right while the profiles were unknown. Two
    // are now confirmed to exist, so the honest schema is the one that names
    // them — the rule was never "assert nothing", it was "assert nothing you
    // have not verified". The tests below enforce that rule instead.
    for (const forbidden of ["aggregateRating", "review", "address", "foundingDate", "telephone"]) {
      expect(org).not.toHaveProperty(forbidden);
    }
  });

  it("corroborates the entity with the profiles it owns", () => {
    // The whole point of the property for this site: a contested brand name is
    // won by the claimant with a verifiable footprint, not the loudest schema.
    // Read through a local, because the property is spread in conditionally
    // (an empty profile list omits it entirely) and is therefore optional to
    // the type system even though it is always present today.
    const sameAs = org.sameAs;
    expect(sameAs).toEqual([...BRAND_PROFILES]);
    expect(sameAs ?? []).not.toHaveLength(0);
  });

  it("lists only absolute https profile URLs, with no duplicates", () => {
    // A relative or http entry is not resolvable as an entity reference, and a
    // duplicated one reads as padding.
    for (const url of BRAND_PROFILES) {
      expect(url).toMatch(/^https:\/\/[^\s]+$/);
    }
    expect(new Set(BRAND_PROFILES).size).toBe(BRAND_PROFILES.length);
  });

  it("does not carry the TikTok handle that does not exist", () => {
    // "officalvantalabs" and "officialvantalabs" are one keystroke apart and
    // only the second is a real account. The first was the handle originally
    // supplied, so this is a regression test for a mistake actually made rather
    // than a hypothetical one.
    const joined = BRAND_PROFILES.join(" ");
    expect(joined).not.toMatch(/offical(?!i)/);
    expect(joined).toContain("@officialvantalabs");
  });
});

describe("WebSite schema", () => {
  const site = webSiteSchema();

  it("uses the same entity naming as the Organization", () => {
    expect(site.name).toBe("Vanta Labs Research");
    expect(site.alternateName).toBe("Vanta Labs");
  });

  it("attributes the site to the Organization node rather than duplicating it", () => {
    expect(site.publisher).toEqual({ "@id": "https://www.vantalabsresearch.com/#organization" });
  });
});
