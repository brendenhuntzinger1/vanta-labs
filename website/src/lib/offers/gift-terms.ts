// No `server-only` here, deliberately: the campaign composer is a Client
// Component and shows the operator the EXACT sentence a recipient will read,
// live, as they build a gift. A verdict that only arrives after Send arrives
// too late — the same reasoning deliverability-check.ts states for its own
// checks.
//
// Everything here is pure: no I/O, no secrets, no database. customer-offers.ts
// re-exports all of it, so every existing server-side caller is untouched and
// there is still one place that decides what a gift means.

/**
 * WHAT AN OFFER CAN GRANT.
 *
 * Two shapes, because they are genuinely different operations rather than two
 * settings of one:
 *
 *   free_product   adds a real order line at $0. Inventory reserves it and its
 *                  COGS is booked, so the store knows what the gift cost.
 *   free_shipping  zeroes the shipping charge. There is no line, no stock and
 *                  no COGS — it is the absence of a fee.
 *   free_shipping_percent
 *                  both at once. The percentage competes in the store's
 *                  single-best-discount rule exactly as a coupon does; the free
 *                  shipping does not, because shipping was never in that race.
 *                  Worst case: the customer keeps a better discount and still
 *                  gets free shipping.
 *
 * Adding another kind means a new branch in quoteOrder and nothing else; adding
 * another PRODUCT gift means one entry below and no code at all.
 */
export type OfferReward =
  /**
   * `quantity` defaults to one and is the number of units granted, not a
   * multiplier on anything else. A cart that already holds the product has
   * those units freed instead of being handed duplicates — "the BAC Water in
   * your cart is on us" and "here are two more bottles of water" are different
   * promises, and only the first is what anyone means. See THE FREE UNIT in
   * quote-order.ts for how the absorb-then-add split works.
   */
  | { kind: "free_product"; productSlug: string; quantity?: number }
  | { kind: "free_shipping" }
  | { kind: "free_shipping_percent"; percent: number }
  /** A percentage off and nothing else. Competes in the coupon slot exactly
   *  as the combined gift's percentage does; shipping is charged as usual. */
  | { kind: "percent"; percent: number }
  /** A $0 product line AND a percentage off the rest. */
  | { kind: "free_product_percent"; productSlug: string; percent: number; quantity?: number };

/**
 * EVERYTHING A MINT NEEDS TO KNOW ABOUT A GIFT.
 *
 * Exactly the shape of an OFFER_CATALOG entry, named so that a gift which has
 * no catalogue entry — one an operator built for a single campaign — can be
 * minted, described and redeemed through the identical code path. It lives
 * here beside OfferReward rather than in campaign-gift.ts so the two modules
 * do not have to import each other.
 */
export type GiftConfig = {
  label: string;
  reward: OfferReward;
  minSubtotalCents: number;
  ttlDays: number;
};

/** How many units a reward grants. One unless the reward says otherwise. */
export function offerRewardQuantity(reward: OfferReward): number | null {
  if (reward.kind !== "free_product" && reward.kind !== "free_product_percent") return null;
  const stated = Number(reward.quantity ?? 1);
  return Number.isFinite(stated) ? Math.max(1, Math.floor(stated)) : 1;
}


export function describeGiftTerms(config: GiftConfig, expiresAt: string): string {
  const minimum = `$${(config.minSubtotalCents / 100).toFixed(config.minSubtotalCents % 100 === 0 ? 0 : 2)}`;
  const deadline = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
  // "a free X is added" is wrong the moment a gift grants more than one, and
  // this line is the store's own statement of what the till will do — the one
  // place the customer's copy and the checkout are guaranteed to agree.
  const count = offerRewardQuantity(config.reward);
  const units = (noun: string) => (count && count > 1 ? `${count} free ${noun} are` : `a free ${noun} is`);
  const gift = config.reward.kind === "free_product"
    ? `${units(config.label.replace(/^\d+\s+/, "").replace(/^free\s+/i, ""))} added to your order`
    : config.reward.kind === "free_product_percent"
      ? `${config.reward.percent}% off, and ${units(config.label.replace(/^.*free\s+/i, ""))} added to your order`
    : config.reward.kind === "free_shipping_percent"
      ? `${config.reward.percent}% off plus free shipping`
      : config.reward.kind === "percent"
        ? `${config.reward.percent}% off`
        : "free shipping";
  return `Your gift: ${gift} on any order of ${minimum} or more, through ${deadline}. `
    + "One per customer, for this email address only. It is applied automatically when you shop through the button below — no code needed.";
}

