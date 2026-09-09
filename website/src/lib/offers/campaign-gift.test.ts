import { describe, expect, it } from "vitest";
import {
  GIFT_MAX_PERCENT,
  GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS,
  campaignOfferKey,
  isCampaignOfferKey,
  validateCampaignGift,
} from "@/lib/offers/campaign-gift";
import { describeGiftTerms } from "@/lib/offers/gift-terms";

// ---------------------------------------------------------------------------
// WHAT A CAMPAIGN GIFT HAS TO GET RIGHT.
//
// Until now a broadcast could only carry `promo_code` — a shared coupon string
// typed into the copy, with no per-recipient binding, no expiry of its own, no
// one-per-customer rule, and nothing stopping it being pasted into a forum. The
// gift below is a real customer_offers row: one per recipient, bound to their
// address, spendable once, priced by quoteOrder from the row rather than from
// any catalogue.
//
// That is exactly why validation matters here rather than at the till. By the
// time the token reaches checkout it is an ordinary offer row and the checkout
// will honour whatever it says — so a 150% discount, a gift naming a retired
// product, or a free vial with no order minimum are all things that have to be
// refused at the moment somebody types them.
// ---------------------------------------------------------------------------

const PRODUCTS = new Set(["bac-water", "ghk-cu", "glp-3"]);

const base = {
  label: "Weekend gift",
  rewardKind: "percent" as const,
  minSubtotalCents: 3500,
  ttlDays: 14,
};

describe("the gifts an operator is allowed to build", () => {
  it("accepts a plain percentage", () => {
    const verdict = validateCampaignGift({ ...base, percent: 20 }, PRODUCTS);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.config.reward).toEqual({ kind: "percent", percent: 20 });
  });

  it("accepts free shipping, which needs neither a product nor a percentage", () => {
    const verdict = validateCampaignGift({ ...base, rewardKind: "free_shipping" }, PRODUCTS);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.config.reward).toEqual({ kind: "free_shipping" });
  });

  it("accepts a free product with a real slug and a real minimum", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity: 2 },
      PRODUCTS,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.config.reward).toEqual({ kind: "free_product", productSlug: "bac-water", quantity: 2 });
    }
  });

  it("accepts a product and a percentage together", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product_percent", productSlug: "ghk-cu", percent: 15, quantity: 1 },
      PRODUCTS,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.config.reward).toEqual({ kind: "free_product_percent", productSlug: "ghk-cu", percent: 15, quantity: 1 });
    }
  });
});

describe("what it refuses, and why each one would cost money", () => {
  // The customer_offers CHECK constraint says percent_off must be > 0 and
  // <= 100. Anything outside that is refused by the database AFTER the email
  // has been rendered and the claim taken, so it has to be refused here.
  it.each([0, -5, 101, 1000, 12.5])("refuses a %s%% discount", (percent) => {
    const verdict = validateCampaignGift({ ...base, percent }, PRODUCTS);
    expect(verdict.ok).toBe(false);
  });

  it(`allows exactly ${GIFT_MAX_PERCENT}%, the database's own ceiling`, () => {
    expect(validateCampaignGift({ ...base, percent: GIFT_MAX_PERCENT }, PRODUCTS).ok).toBe(true);
  });

  // quoteOrder resolves the product half with an exact slug match and NO
  // fallback, so a wrong slug does not throw and does not degrade visibly: the
  // free line is never pushed, the percentage half still applies, and the
  // customer gets the discount the email promised and none of the product. That
  // shipped once already, after the bac-water rename.
  it("refuses a product that is not on sale", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "retired-peptide", quantity: 1 },
      PRODUCTS,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("retired-peptide");
  });

  it("refuses a product gift with no product chosen", () => {
    expect(validateCampaignGift({ ...base, rewardKind: "free_product", quantity: 1 }, PRODUCTS).ok).toBe(false);
  });

  // "With no minimum, the correct play for a recipient is to redeem the token
  // with nothing else in the basket: the store ships a vial, collects the
  // postage, and books the COGS as a loss." — OFFER_CATALOG, on the free GHK-Cu.
  it("refuses a free product with no order minimum", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity: 1, minSubtotalCents: 0 },
      PRODUCTS,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("order minimum");
  });

  it(`allows a free product at exactly the $${GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS / 100} floor`, () => {
    expect(validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity: 1, minSubtotalCents: GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS },
      PRODUCTS,
    ).ok).toBe(true);
  });

  // A percentage of nothing is nothing, so this one needs no floor.
  it("allows a percentage gift with no minimum", () => {
    expect(validateCampaignGift({ ...base, percent: 10, minSubtotalCents: 0 }, PRODUCTS).ok).toBe(true);
  });

  it.each([0, -1, 91, 3.5])("refuses a lifetime of %s days", (ttlDays) => {
    expect(validateCampaignGift({ ...base, percent: 10, ttlDays }, PRODUCTS).ok).toBe(false);
  });

  it.each([0, 11, -2])("refuses a quantity of %s", (quantity) => {
    expect(validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity },
      PRODUCTS,
    ).ok).toBe(false);
  });

  it("refuses an unnamed gift, because reports and the email both need the name", () => {
    expect(validateCampaignGift({ ...base, label: "   ", percent: 10 }, PRODUCTS).ok).toBe(false);
  });

  it.each([null, undefined, "a gift", 42, []])("refuses %o, which is not a gift at all", (spec) => {
    expect(validateCampaignGift(spec, PRODUCTS).ok).toBe(false);
  });

  it("refuses a reward kind nobody implemented", () => {
    expect(validateCampaignGift({ ...base, rewardKind: "free_pony" }, PRODUCTS).ok).toBe(false);
  });

  // A REFUSAL, NEVER A SILENT CORRECTION. Clamping 150% to 100% would send an
  // email promising a discount nobody chose.
  it("does not quietly clamp an out-of-range percentage", () => {
    const verdict = validateCampaignGift({ ...base, percent: 150 }, PRODUCTS);
    expect(verdict.ok).toBe(false);
  });

  // The composer passes its loaded catalogue; the API passes null and lets the
  // route's own catalogue read decide. Neither may skip the OTHER rules.
  it("still applies every non-product rule when the product check is skipped", () => {
    expect(validateCampaignGift({ ...base, percent: 500 }, null).ok).toBe(false);
    expect(validateCampaignGift({ ...base, rewardKind: "free_product", productSlug: "anything", minSubtotalCents: 0 }, null).ok).toBe(false);
  });
});

// The email's terms line and the row quoteOrder prices must be one statement,
// not two that happen to agree today.
describe("the terms the recipient reads", () => {
  const expires = "2026-10-01T00:00:00Z";

  it("states the product, the minimum and the deadline", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity: 1, minSubtotalCents: 3500, label: "Free Recon water" },
      PRODUCTS,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const terms = describeGiftTerms(verdict.config, expires);
    expect(terms).toContain("$35");
    // Rendered in America/New_York, which is the store's operating timezone —
    // so a UTC midnight expiry reads as the previous evening's date. Deliberate
    // and pre-existing: the customer should see the deadline in the timezone the
    // store's own deadlines are set in, not in UTC.
    expect(terms).toContain("September 30, 2026");
    expect(terms).toContain("One per customer");
  });

  it("says two are added when the gift grants two", () => {
    const verdict = validateCampaignGift(
      { ...base, rewardKind: "free_product", productSlug: "bac-water", quantity: 2, label: "Free Recon water" },
      PRODUCTS,
    );
    if (!verdict.ok) throw new Error(verdict.error);
    expect(describeGiftTerms(verdict.config, expires)).toContain("2 free");
  });

  it("states the percentage for a percentage gift", () => {
    const verdict = validateCampaignGift({ ...base, percent: 25 }, PRODUCTS);
    if (!verdict.ok) throw new Error(verdict.error);
    expect(describeGiftTerms(verdict.config, expires)).toContain("25% off");
  });
});

// One live offer per (offer_key, email) is a partial unique index. Filing a
// campaign gift under the campaign's own id is what makes that invariant mean
// "one gift per recipient per campaign" rather than "one gift, ever".
describe("the offer key a campaign gift is filed under", () => {
  it("is namespaced by the campaign id", () => {
    expect(campaignOfferKey("abc-123")).toBe("campaign:abc-123");
    expect(isCampaignOfferKey("campaign:abc-123")).toBe(true);
  });

  it("can never collide with a catalogue key", () => {
    expect(isCampaignOfferKey("winback_60_free_ghkcu")).toBe(false);
    expect(campaignOfferKey("winback_60_free_ghkcu")).not.toBe("winback_60_free_ghkcu");
  });

  it("gives two campaigns two different keys, so a second gift is a real second gift", () => {
    expect(campaignOfferKey("one")).not.toBe(campaignOfferKey("two"));
  });
});
