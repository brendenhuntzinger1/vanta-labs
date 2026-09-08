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
/** One product in a multi-product gift. */
export type GiftItem = { slug: string; quantity: number; variantId: string | null };

/**
 * Read a stored `gift_items` value into something safe to price from.
 *
 * A jsonb column is whatever was last written to it, and this one decides what
 * the store gives away for free — so nothing here trusts its shape. A row that
 * cannot be read yields an EMPTY list, which grants nothing: the safe direction
 * for a gift is to withhold it and leave the token spendable, never to guess.
 *
 * Quantities are floored to a whole number at or above one, for the same reason
 * the single-product path does it: a fractional or negative count reaches
 * order_items and becomes an un-shippable pick list rather than a pricing bug.
 */
export function normalizeGiftItems(value: unknown): GiftItem[] {
  if (!Array.isArray(value)) return [];
  const out: GiftItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const slug = String(entry.slug ?? "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const stored = Number(entry.quantity ?? 1);
    const quantity = Number.isFinite(stored) ? Math.max(1, Math.floor(stored)) : 1;
    const variantId = typeof entry.variantId === "string" && entry.variantId ? entry.variantId : null;
    out.push({ slug, quantity, variantId });
  }
  return out;
}

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
  | { kind: "free_product_percent"; productSlug: string; percent: number; quantity?: number }
  /**
   * SEVERAL DIFFERENT PRODUCTS, free.
   *
   * The single-product kinds grant N units of ONE thing, which cannot express
   * "a GLOW and a GHK-Cu and a BAC Water" — the top of the cart-recovery
   * ladder. At this store's real dose costs that three-vial gift costs less
   * than a tenth of what a percentage costs on the same cart, so it is the
   * cheapest strong offer available and worth its own shape.
   */
  | { kind: "free_products"; items: GiftItem[] }
  /** The same, plus a percentage off the rest. */
  | { kind: "free_products_percent"; items: GiftItem[]; percent: number };

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
  // A MULTI-ITEM GIFT NAMES ITSELF FROM ITS LABEL.
  //
  // The single-product kinds derive their wording from the catalogue entry's
  // label, stripping the "free" and any leading count so the sentence reads
  // "a free X is added". A multi-item gift cannot be reconstructed that way —
  // "a free GLOW + GHK-Cu + BAC Water is added" is wrong in both number and
  // grammar — so the caller builds the label from real product names and this
  // states it whole. It is still the SAME config the mint wrote onto the row,
  // which is the property that keeps the email and the till in agreement.
  if (config.reward.kind === "free_products" || config.reward.kind === "free_products_percent") {
    const percentPart = config.reward.kind === "free_products_percent"
      ? `${config.reward.percent}% off, and `
      : "";
    return `Your gift: ${percentPart}${config.label} added to your order on any order of ${minimum} or more, `
      + `through ${deadline}. `
      + "One per customer, for this email address only. It is applied automatically when you shop "
      + "through the button below — no code needed.";
  }

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

