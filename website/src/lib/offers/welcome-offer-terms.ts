// No `server-only` here, deliberately: quoteOrder, the welcome-gift minter
// and the Omnisend code minter all need to agree on what "the welcome offer"
// is, and a pure module with no I/O is the one place they can agree without
// importing each other. Nothing here reads a database or a secret.

/**
 * THE WELCOME OFFER IS ONE OFFER WITH TWO SHAPES, AND THE SHOPPER PICKS ONE.
 *
 * A new subscriber who has never bought is handed both at once: a free
 * GHK-Cu vial (a customer_offers row, claimed through the click link that
 * sets the vl_offer cookie) and a 15% code (a coupons row bound to the
 * address). Either one is spendable on a first order; never both. The
 * checkout enforces the "never both" rule (quote-order.ts): when a welcome
 * code is typed, the gift is withdrawn from the order and the banner says
 * so, because the code the shopper deliberately typed is the choice they
 * made.
 *
 * Why two rows rather than one row with a choice column: a coupon code can
 * be typed anywhere (from a text message, from memory) and a gift needs a
 * bearer token, so the two already have different transports; giving them
 * one identity here is cheaper than teaching either transport the other's
 * job.
 */

/** The customer_offers key the free vial files under. One live row per address. */
export const WELCOME_GIFT_OFFER_KEY = "welcome_free_ghkcu";

/**
 * WHETHER THE VIAL IS OFFERED AT ALL. The owner chose the 15% code alone for
 * now (2026-09-16 evening), so nothing mints the vial: the minter
 * (welcome-gift.ts), the contact properties, the checkout rule below, the
 * welcome-offer flow's gift split and the vial template are all in place and
 * dormant. Flip this to true and a never-bought subscriber gets both halves
 * again, one or the other at the till. Nothing else needs to change.
 */
export const WELCOME_GIFT_ENABLED = false;

/** The `coupons.source` values that mean "this code is the welcome offer". */
export const WELCOME_CODE_SOURCES = new Set<string>([
  // The per-contact code the store mints for Omnisend's welcome flow (codes.ts).
  "omnisend_welcome",
  // The owner's public first-order code from the admin control centre (coupons.ts
  // validateCoupon), a synthetic coupon with no row. Off in production today;
  // if it is ever switched on it is still a welcome offer, so it still excludes the gift.
  "welcome_offer",
]);

/** Is a validated coupon the welcome offer, whichever minter produced it? */
export function isWelcomeCodeSource(source: string | null | undefined): boolean {
  return typeof source === "string" && WELCOME_CODE_SOURCES.has(source);
}

/** The gift the welcome offer ships, by slug; named from the catalogue at send time. */
export const WELCOME_GIFT_PRODUCT_SLUG = "ghk-cu";
