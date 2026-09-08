import "server-only";

import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { OFFER_CATALOG, isOfferKey, type GiftConfig } from "@/lib/offers/customer-offers";
import { validateCampaignGift } from "@/lib/offers/campaign-gift";

/**
 * The gift a stored campaign row actually carries, resolved against the LIVE
 * catalogue at the moment of sending.
 *
 * WHY IT IS RE-CHECKED HERE AND NOT ONLY ON SAVE. A campaign can be composed on
 * Monday and scheduled for Friday, and a product can be retired in between.
 * quoteOrder resolves the product half of a gift with an exact slug match and
 * NO fallback, so a gift naming a dead slug does not throw and does not degrade
 * visibly: `offerProduct` is undefined, the free line is never pushed, and the
 * percentage half still applies. The customer gets the discount the email
 * promised and none of the product it promised.
 *
 * That is not hypothetical — it shipped once already, when a rename moved
 * production from `bacteriostatic-water` to `bac-water` and the day-40 win-back
 * mailed a percentage and no vial for weeks. The composer's check is the fast
 * feedback; this one is the guarantee.
 *
 * THREE ANSWERS, AND THE THIRD IS THE IMPORTANT ONE:
 *
 *   { gift: null }        this campaign carries no gift. Send it as it is.
 *   { gift: config }      mint this per recipient.
 *   { error: "..." }      the campaign SAYS it carries a gift and the gift is
 *                         not deliverable. The caller must refuse to send
 *                         rather than send the copy without it — an email whose
 *                         body promises a free vial and whose token grants
 *                         nothing is worse than an email that was never sent,
 *                         because the store then has to argue with a customer
 *                         about what it said.
 */
export type ResolvedCampaignGift =
  | { gift: GiftConfig | null; error?: undefined }
  | { gift?: undefined; error: string };

export async function resolveCampaignGift(campaign: {
  offer_key?: string | null;
  offer_custom?: unknown;
}): Promise<ResolvedCampaignGift> {
  const key = String(campaign.offer_key ?? "").trim();
  const custom = campaign.offer_custom ?? null;

  // The database CHECK makes this unreachable for rows written through the
  // API. It is still asserted, because a hand-edited row must not silently
  // resolve to whichever branch happens to be tested first.
  if (key && custom) {
    return { error: "This campaign names both a catalogue gift and a custom one. Choose one." };
  }

  if (!key && !custom) return { gift: null };

  const config: GiftConfig | null = key
    ? (isOfferKey(key) ? OFFER_CATALOG[key] : null)
    : (() => {
        const verdict = validateCampaignGift(custom, null);
        return verdict.ok ? verdict.config : null;
      })();

  if (!config) {
    return {
      error: key
        ? `This campaign names a gift ("${key}") that is no longer in the catalogue.`
        : "This campaign's custom gift is no longer valid.",
    };
  }

  const slug = "productSlug" in config.reward ? config.reward.productSlug : "";
  if (slug) {
    try {
      const products = await getCatalogProductsBySlugs([slug]);
      if (products.length === 0) {
        return { error: `The gift names "${slug}", which is not on sale. The email would promise a product the checkout cannot add.` };
      }
    } catch (error) {
      // A CATALOGUE READ FAILURE IS NOT PERMISSION TO SEND. Falling open here
      // would mail the promise and hope, which is the one outcome that costs a
      // customer relationship rather than a sweep. The campaign stays queued
      // and the next sweep asks again.
      return { error: `Could not confirm the gift's product is on sale: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { gift: config };
}
