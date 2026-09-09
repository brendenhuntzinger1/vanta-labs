import { describe, expect, it } from "vitest";

import { BAC_WATER_SLUG, BAC_WATER_SLUG_CANDIDATES } from "@/lib/bac-water";
import { DEFAULT_RECOVERY_TIERS } from "@/lib/cart-recovery-tiers";
import { OFFER_CATALOG } from "@/lib/offers/customer-offers";

// ---------------------------------------------------------------------------
// A GIFT SLUG THAT NAMES A PRODUCT THE CATALOGUE NO LONGER PUBLISHES IS
// SILENT, NOT LOUD.
//
// quote-order resolves a gift with an exact match:
//
//     catalogProducts.find((candidate) => candidate.slug === grant.slug)
//
// and then `shippable = Boolean(offerProduct) && ...`. A slug with no row is
// therefore not an error -- it is a falsy `shippable`, the gift is dropped, and
// the order completes without it. The customer was promised a free vial in the
// email and receives none.
//
// This has now happened TWICE on the same product:
//
//   1. rename-bac-water-slug.sql moved production to "bac-water" while
//      offers/customer-offers.ts still said "bacteriostatic-water". The day-40
//      win-back promised "a free BAC Water on us" and shipped nothing. The
//      suite stayed green because the catalogue mock carried the same stale
//      literal, so both sides of the assertion were wrong together.
//
//   2. rename-to-recon-water.sql moved production to "recon-water" while
//      DEFAULT_RECOVERY_TIERS still held six `slug: "bac-water"` literals --
//      every band's Recon Water gift, silently ungranted.
//
// Both were literals restating a slug that lives in exactly one place. This
// test fails on the restatement rather than on the outcome, because the outcome
// is invisible until someone reconciles an order against the email that sold
// it.
// ---------------------------------------------------------------------------

/** Every gift slug the shipped recovery ladder can grant. */
function recoveryGiftSlugs(): string[] {
  return DEFAULT_RECOVERY_TIERS.flatMap((tier) => [
    ...tier.stage3.map((gift) => gift.slug),
    ...tier.stage4.gifts.map((gift) => gift.slug),
  ]);
}

/** Every product slug the offer catalogue can grant. */
function offerGiftSlugs(): string[] {
  return Object.values(OFFER_CATALOG).flatMap((offer) => {
    const reward = offer.reward as { productSlug?: string; items?: { slug: string }[] };
    return [
      ...(reward.productSlug ? [reward.productSlug] : []),
      ...(reward.items?.map((item) => item.slug) ?? []),
    ];
  });
}

/**
 * The retired spellings. A gift may name the CURRENT slug; naming a previous
 * one means the config was written against a catalogue that no longer exists.
 */
const RETIRED_SLUGS = BAC_WATER_SLUG_CANDIDATES.filter((slug) => slug !== BAC_WATER_SLUG);

describe("gift configuration tracks the catalogue rather than restating it", () => {
  it("the recovery ladder grants Recon water under its current slug", () => {
    const granted = recoveryGiftSlugs();

    // Guards the test itself: if the ladder stops granting this product at all,
    // the assertion below would pass vacuously.
    expect(granted).toContain(BAC_WATER_SLUG);

    for (const retired of RETIRED_SLUGS) {
      expect(granted).not.toContain(retired);
    }
  });

  it("the offer catalogue grants Recon water under its current slug", () => {
    const granted = offerGiftSlugs();

    expect(granted).toContain(BAC_WATER_SLUG);

    for (const retired of RETIRED_SLUGS) {
      expect(granted).not.toContain(retired);
    }
  });

  it("every gift slug resolves against a catalogue keyed by the canonical slug", () => {
    // The catalogue as quote-order sees it: whatever slugs the store actually
    // publishes. Anything a gift names that is not in here is a gift that
    // cannot be granted.
    const published = new Set([BAC_WATER_SLUG, "ghk-cu", "klow", "bpc-157-10mg"]);

    const unresolvable = [...recoveryGiftSlugs(), ...offerGiftSlugs()]
      .filter((slug) => !published.has(slug));

    expect(unresolvable).toEqual([]);
  });
});
