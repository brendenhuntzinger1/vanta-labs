import { describe, expect, it } from "vitest";
import { describeOfferTerms, isOfferKey, OFFER_CATALOG } from "@/lib/offers/customer-offers";

// ---------------------------------------------------------------------------
// THE RETENTION LADDER'S OFFER BUMP, 2026-09-06.
//
// The owner asked for two of the three win-back gifts to get stronger:
// day 30 goes from free-shipping-only to free shipping + 10% off, and day 40
// goes from 10% off + free BAC water to 15% off + free BAC water. Day 50's
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
    ["winback_60_bac_water_15", { kind: "free_product_percent", productSlug: "bacteriostatic-water", percent: 15 }],
  ] as const)("%s is a known offer key with the expected reward", (key, reward) => {
    expect(isOfferKey(key)).toBe(true);
    expect(OFFER_CATALOG[key].reward).toEqual(reward);
  });

  it("keeps the old 10%-off BAC water gift in place for whatever already points at it", () => {
    expect(isOfferKey("winback_60_bac_water_10")).toBe(true);
    expect(OFFER_CATALOG.winback_60_bac_water_10.reward).toEqual({
      kind: "free_product_percent", productSlug: "bacteriostatic-water", percent: 10,
    });
  });

  it("describes the free-shipping + 10% gift correctly", () => {
    const terms = describeOfferTerms("winback_60_free_shipping_10", "2026-12-01T00:00:00Z");
    expect(terms).toContain("10% off plus free shipping");
    expect(terms).toContain("$35");
  });

  it("describes the 15%-off BAC water gift correctly", () => {
    const terms = describeOfferTerms("winback_60_bac_water_15", "2026-12-01T00:00:00Z");
    expect(terms).toContain("15% off, and a free BAC water is added to your order");
  });
});
