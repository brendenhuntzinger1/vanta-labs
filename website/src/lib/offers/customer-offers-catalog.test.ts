import { describe, expect, it } from "vitest";
import { BAC_WATER_SLUG, BAC_WATER_SLUG_CANDIDATES } from "@/lib/bac-water";
import { describeOfferTerms, isOfferKey, OFFER_CATALOG, type OfferKey } from "@/lib/offers/customer-offers";

// ---------------------------------------------------------------------------
// THE RETENTION LADDER'S OFFER BUMP, 2026-09-06.
//
// The owner asked for two of the three win-back gifts to get stronger:
// day 30 goes from free-shipping-only to free shipping + 10% off, and day 40
// goes from 10% off + free Recon water to 15% off + free Recon water. Day 50's
// free GHK-Cu is untouched.
//
// Which automation fires which offer_key is admin-configured (see
// email-lifecycle-2026-09-04.sql: "delay_days, offer_key, promo_code and
// enabled are left exactly as the operator set them"), so the new gifts are
// added here as new catalog entries rather than edits to the existing ones —
// an operator picks them from the Admin -> Email dropdown when ready, and
// nothing already pointing at the old keys changes underneath it.
// ---------------------------------------------------------------------------

describe("the new win-back gifts added for the 30/40-day offer bump", () => {
  it.each([
    ["winback_60_free_shipping_10", { kind: "free_shipping_percent", percent: 10 }],
    ["winback_60_bac_water_15", { kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 15 }],
  ] as const)("%s is a known offer key with the expected reward", (key, reward) => {
    expect(isOfferKey(key)).toBe(true);
    expect(OFFER_CATALOG[key].reward).toEqual(reward);
  });

  it("keeps the old 10%-off Recon water gift in place for whatever already points at it", () => {
    expect(isOfferKey("winback_60_bac_water_10")).toBe(true);
    expect(OFFER_CATALOG.winback_60_bac_water_10.reward).toEqual({
      kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 10,
    });
  });

  it("describes the free-shipping + 10% gift correctly", () => {
    const terms = describeOfferTerms("winback_60_free_shipping_10", "2026-12-01T00:00:00Z");
    expect(terms).toContain("10% off plus free shipping");
    expect(terms).toContain("$35");
  });

  it("describes the 15%-off Recon water gift correctly", () => {
    const terms = describeOfferTerms("winback_60_bac_water_15", "2026-12-01T00:00:00Z");
    expect(terms).toContain("15% off, and a free Recon water is added to your order");
  });
});

// ---------------------------------------------------------------------------
// A GIFT'S SLUG MUST BE THE ONE THE DATABASE USES.
//
// quoteOrder resolves the product half with an exact match —
// `catalogProducts.find((candidate) => candidate.slug === offer.product_slug)`
// — and there is no candidate-list fallback there, unlike the Recon Water
// cross-sell. So a slug this catalogue gets wrong does not throw and does not
// degrade visibly: `offerProduct` is undefined, `shippable` is false, the gift
// line is never pushed, and the percentage half still applies. The customer
// gets the discount the email promised and none of the product it promised.
//
// That is not hypothetical. rename-bac-water-slug.sql moved production from
// "bacteriostatic-water" to "bac-water"; this catalogue kept the old literal,
// and so did the catalogue mock in offer-percent-competition.test.ts — so the
// behavioural test agreed with the stale catalogue and the pair stayed green
// while the live day-40 mail shipped no vial.
//
// Pinning to bac-water.ts is what stops that recurring: one module decides the
// slug, and index 0 of its candidate list is the canonical one by contract.
// ---------------------------------------------------------------------------

describe("every product gift points at a canonical slug", () => {
  const productSlugs = (Object.entries(OFFER_CATALOG) as Array<[OfferKey, (typeof OFFER_CATALOG)[OfferKey]]>)
    .flatMap(([key, entry]) =>
      "productSlug" in entry.reward ? [[key, entry.reward.productSlug] as const] : []);

  it("covers every gift that grants a product", () => {
    expect(productSlugs.map(([key]) => key)).toEqual([
      "winback_60_free_ghkcu",
      "winback_60_bac_water_10",
      "winback_60_bac_water_15",
      "labor_day_bac_water_2",
      "labor_day_bac_water_2_40",
      "labor_day_bac_water_2_70",
      // The standing cart-recovery gift, carried by stages 3 and 4 of the
      // rebuilt ladder. A pure product with no percentage, so it lands
      // alongside a live promotion instead of competing with it.
      "cart_recovery_bac_water",
    ]);
  });

  // The retired slugs still resolve for links and bookmarks (middleware 308s
  // them), but they are NOT rows in `products` any more, so a gift naming one
  // resolves to nothing.
  const retired = BAC_WATER_SLUG_CANDIDATES.slice(1);

  it.each(productSlugs)("%s does not name a retired slug", (_key, slug) => {
    expect(retired).not.toContain(slug);
  });

  it("takes the Recon Water slug from bac-water.ts rather than typing it again", () => {
    for (const [key, slug] of productSlugs) {
      if (key.includes("bac_water")) expect(slug).toBe(BAC_WATER_SLUG);
    }
  });
});
