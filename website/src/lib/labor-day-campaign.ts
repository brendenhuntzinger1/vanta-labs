import { offerId, type OfferTheme, type StorefrontOffer } from "@/lib/storefront-offer-format";

// ---------------------------------------------------------------------------
// A SEASONAL CAMPAIGN IS PAINT AND WORDS. IT IS NOT A DISCOUNT.
//
// This module decides that the offers bar wears a flag between two dates, and
// which single offer gets to call itself a Labor Day sale. It decides NOTHING
// about who gets money off, how much, or whether a promotion runs at all.
//
// That boundary is the whole design, and it is the same one storefront-offers
// draws: the discount is owned by the system that enforces it — the promotion
// centre (bxgy-engine, via quote-order) for Buy 2 Get 1 Free, the coupons table
// (via validateCoupon) for 20% off sitewide. A campaign that could state a
// percentage would be a second source of truth for the price, and the first
// time the two disagreed the bar would advertise a total the card is not
// charged. So a campaign owns an eyebrow, a window, and a CSS theme. Nothing
// that costs money.
//
// WHICH SALE IS RUNNING IS NOT THIS FILE'S QUESTION EITHER. The store owner
// turns one promotion on in admin and the other off; whatever is live arrives
// here as an offer, already resolved, already priced. The banner dresses it.
// Switch the toggle and a different offer arrives and gets dressed instead —
// which is exactly why nothing here names Buy 2 Get 1 or 20% off.
//
// WHY IT IS DATED RATHER THAN A CHECKBOX. A "Labor Day mode" switch in admin
// is a switch somebody has to remember to turn off, and the failure mode is a
// flag still flying in October. A window closes itself. When it does, the
// offers underneath are untouched and the bar goes back to gold on its own.
// ---------------------------------------------------------------------------

export interface SeasonalCampaign {
  /** Joined onto branded offer ids, so it must be stable for the campaign's life. */
  id: string;
  /** Replaces the offer's own eyebrow. The small line, never the headline. */
  eyebrow: string;
  /** The bar's visual treatment. See .vl-offer-bar--americana in globals.css. */
  theme: OfferTheme;
  /** Inclusive. ISO, with an explicit offset — see the note below. */
  startsAt: string;
  /** Exclusive: the first instant the campaign is over. */
  endsAt: string;
}

/**
 * Labor Day 2026: 4–13 September inclusive, in the store's business zone.
 *
 * THE OFFSETS ARE WRITTEN OUT ON PURPOSE. The store displays dates in
 * America/New_York (DISPLAY_TIME_ZONE in format-date.ts) and a shopper's "the
 * sale runs the 4th through the 13th" means Eastern days, not UTC ones.
 * Anchored in UTC instead, the banner would arrive four hours late on the first
 * morning and vanish at 8pm on the last night — the two busiest hours of a
 * holiday sale. September is EDT (UTC-4) every year, so the offset is a
 * constant here rather than something to compute.
 *
 * The end is EXCLUSIVE and set to midnight on the 14th, which is how "runs to
 * midnight on Sunday the 13th" is written without an off-by-one-second.
 *
 * IT RAN TO THE 8TH FIRST, AND THE COPY HAD TO MOVE WITH THE DATE. The eyebrow
 * said "Labor Day Weekend", which was true of a five-day window ending the
 * Tuesday after the holiday and is plainly false by the second Friday. A
 * seasonal banner is the one place where stretching a date quietly makes the
 * words lie, so the window and the wording are set together, here, in one
 * object.
 */
export const LABOR_DAY_2026: SeasonalCampaign = {
  id: "labor-day-2026",
  eyebrow: "Labor Day Sale",
  theme: "americana",
  startsAt: "2026-09-04T00:00:00-04:00",
  endsAt: "2026-09-14T00:00:00-04:00",
};

/** Every campaign the store knows about. One, today. */
const CAMPAIGNS: readonly SeasonalCampaign[] = [LABOR_DAY_2026];

/**
 * The campaign running at `now`, or null.
 *
 * Null is the normal answer — 360 days a year — and it is the answer that
 * restores the ordinary gold bar with no action from anybody.
 */
export function activeSeasonalCampaign(now: Date = new Date()): SeasonalCampaign | null {
  const at = now.getTime();
  if (!Number.isFinite(at)) return null;
  for (const campaign of CAMPAIGNS) {
    const from = Date.parse(campaign.startsAt);
    const until = Date.parse(campaign.endsAt);
    if (!Number.isFinite(from) || !Number.isFinite(until)) continue;
    if (at >= from && at < until) return campaign;
  }
  return null;
}

/**
 * Dress EXACTLY ONE offer in the campaign, and return the rest untouched.
 *
 * ONE, because the bar renders one offer and the sheet lists them all: if two
 * offers both said "Labor Day Weekend", a shopper who opened ALL OFFERS would
 * read two Labor Day sales and reasonably ask which one they get. The store
 * owner runs a single sale — they switch one promotion on and the other off —
 * so in practice there is only one candidate anyway. This is the guarantee for
 * when there is not.
 *
 * The one chosen is the FIRST non-standing offer in the list as given. The list
 * arrives sorted by priority from storefront-offers, and the bar leads with the
 * first of them, so "the offer that leads the bar" and "the offer wearing the
 * flag" are the same offer by construction rather than by coincidence. Sorting
 * again here would be a second opinion about which one leads, and two opinions
 * is how they end up disagreeing.
 *
 * Standing terms are skipped outright. Free shipping, quantity pricing and
 * membership pricing are always on; dressing one as a holiday sale advertises a
 * Labor Day discount that does not exist.
 */
export function brandOffersForSeason(
  offers: StorefrontOffer[],
  campaign: SeasonalCampaign | null,
): StorefrontOffer[] {
  if (!campaign) return offers;
  const lead = offers.findIndex((offer) => !offer.standing);
  if (lead < 0) return offers;

  return offers.map((offer, index) => {
    if (index !== lead) return offer;
    return {
      ...offer,
      // The id is content-derived and dismissal is keyed on it (see
      // storefront-offer-format). Joining the campaign on means somebody who
      // waved away the plain "Buy 2 Get 1 Free" last week is shown it again
      // dressed for the sale — the offer genuinely changed, so it is genuinely
      // a new one.
      id: offerId([offer.id, campaign.id]),
      eyebrow: campaign.eyebrow,
      theme: campaign.theme,
      // headline, code, automaticNote, endsAt, details, href, priority and
      // standing are deliberately NOT touched. They describe the promotion
      // that is actually enforced, and this function does not price anything.
    };
  });
}
