import type { GiftConfig, OfferKey } from "@/lib/offers/customer-offers";
import {
  DEFAULT_RECOVERY_TIERS,
  tierForCart,
  type RecoveryGiftItem,
  type RecoveryTier,
} from "@/lib/cart-recovery-tiers";

/**
 * WHAT EACH RECOVERY STAGE MAY OFFER THIS PARTICULAR CART.
 *
 * The old ladder gave every cart the same four messages and put its only
 * incentive — five percent — on the last one. Both halves were wrong, in
 * opposite directions.
 *
 * TOO LITTLE, TOO LATE. Forty-one emails to real customers produced one click
 * and no click-attributed recovery. The first three messages gave nobody a
 * reason to act; the fourth arrived after they had already ignored three.
 *
 * TOO MUCH, TOO INDISCRIMINATELY. The incentive went to everyone who reached
 * t72h — including shoppers inside their own reorder cycle who were coming back
 * regardless, and including an address on its second and third abandonment.
 *
 * So an incentive here is EARNED and BOUNDED. Earned: nothing until the shopper
 * has ignored two messages that cost the store nothing. Bounded: never to a
 * recent buyer, never twice to one address inside thirty days, never on a cart
 * too small to carry it.
 *
 * A PLAN IS A REQUEST, NOT A PROMISE. This says what a stage MAY carry; what
 * the email says comes from what was actually minted behind the stage claim
 * (see reserveAndSendStage). A gift that fails to mint means a message without
 * one, never a message that promises one.
 *
 * Pure, so every rule below is pinned without a database.
 */

export type RecoveryOfferStage = "t30m" | "t12h" | "t24h" | "t72h";

/**
 * ONE GIFT PER ADDRESS PER THIRTY DAYS, matching the coupon cooldown that has
 * always governed the discount. The two are tracked separately because they are
 * different costs answering different objections — a shopper given a code last
 * month may still be the right person to give a vial to — but the shape of the
 * rule is the same, and for the same reason: an incentive that recurs on demand
 * is a price change, and shoppers learn price changes faster than anything else.
 */
export const RECOVERY_GIFT_COOLDOWN_MS = 30 * 24 * 3_600_000;

/** Someone who bought this recently is finishing a reorder, not being won back. */
export const RECOVERY_RECENT_BUYER_MS = 30 * 24 * 3_600_000;

/**
 * The smallest cart worth attaching a free vial to.
 *
 * Recon Water is $14.99 retail. Against a $20 basket the gift is a loss dressed
 * as a recovery, and the shopper most likely to take it is the one who was
 * going to buy the $20 anyway. $35 is a little over two vials and matches the
 * floor every other product gift in OFFER_CATALOG already uses.
 */
export const RECOVERY_GIFT_MIN_CART_CENTS = 3_500;

/** How long a recovery gift stays spendable. Long enough to be a real offer,
 *  short enough that the liability does not sit open past the sequence. */
export const RECOVERY_GIFT_TTL_DAYS = 10;

/** The gift the recovery ladder hands out. Its own key — nothing on the
 *  retention ladder points at it, and nothing should. */
export const RECOVERY_GIFT_OFFER_KEY = "cart_recovery_bac_water" satisfies OfferKey;

export interface RecoveryOfferContext {
  stage: RecoveryOfferStage;
  cartValueCents: number;
  /** The address's most recent paid product order, or null. */
  lastPaidAt: number | null;
  /** The most recent cart-recovery COUPON minted for this address, any cart. */
  lastRecoveryCouponAt: number | null;
  /** The most recent cart-recovery GIFT issued to this address, any cart. */
  lastRecoveryGiftAt: number | null;
  /**
   * The operator's global recovery discount, and it is now a MASTER SWITCH
   * rather than the value. Each band carries its own percentage; setting this
   * to zero turns every recovery coupon off at once, which is the control an
   * operator reaches for when something is wrong and they want it stopped
   * without editing four bands.
   */
  discountPercent: number;
  /**
   * The cart-value bands. Defaults to the shipped ladder so every existing
   * caller and test keeps working; the sweep passes the operator's saved
   * configuration.
   */
  tiers?: RecoveryTier[];
  now: number;
}

export interface RecoveryOfferPlan {
  /**
   * The slot this gift is filed under, or null for no gift.
   *
   * A STABLE IDENTIFIER, NOT A DESCRIPTION. It reads `cart_recovery_bac_water`
   * for historical reasons and now files a gift that may be a GLOW, a GHK-Cu
   * and a Recon Water together. That is deliberate: the key is what the
   * one-live-offer index and the 30-day gift cooldown key on, so renaming it
   * would orphan every live token and reset every cooldown. What the gift
   * actually grants is recorded on the row, which is the only thing the
   * checkout reads.
   */
  offerKey: OfferKey | null;
  /** The products this stage gifts, decided by the cart's band. */
  gifts: RecoveryGiftItem[];
  /** Whether this stage may carry a percentage coupon. */
  coupon: boolean;
  /** The band's percentage. Zero when this band carries none. */
  percent: number;
  /** Why, in words — logged, and shown in the admin beside the send. */
  reason: string;
  /**
   * Whether the MESSAGE itself should be withheld. Always false today, and
   * present so a future rule that suppresses a send (rather than an incentive)
   * has somewhere honest to live: withholding an incentive must never quietly
   * become withholding the reminder, which costs nothing and is the only part
   * that has ever recovered a cart here.
   */
  suppressed: boolean;
}

function withinCooldown(last: number | null, window: number, now: number): boolean {
  return last !== null && now - last < window;
}

export function planStageOffer(context: RecoveryOfferContext): RecoveryOfferPlan {
  const none = (reason: string): RecoveryOfferPlan =>
    ({ offerKey: null, gifts: [], coupon: false, percent: 0, reason, suppressed: false });

  // STAGES ONE AND TWO CARRY NOTHING, DELIBERATELY. A discount on the first
  // reminder is a discount for having been interrupted, and it teaches the
  // fastest lesson a store can teach: abandon the cart and wait.
  //
  // It is also what keeps the programme honest about its own cost. A shopper
  // who was coming back anyway usually comes back early, so the two messages
  // that cost nothing catch them for free and only somebody who has ignored
  // both is ever paid to return.
  if (context.stage === "t30m") return none("reminder only: no incentive at stage 1");
  if (context.stage === "t12h") return none("reassurance only: no incentive at stage 2");

  // A recent buyer is inside a reorder cycle. Paying them changes nothing they
  // were not already going to do, and it is the most expensive kind of
  // discount because it converts at exactly the rate of no discount at all.
  if (withinCooldown(context.lastPaidAt, RECOVERY_RECENT_BUYER_MS, context.now)) {
    return none("no incentive: recent buyer inside their own reorder cycle");
  }

  // WHICH BAND THIS CART IS IN DECIDES EVERYTHING BELOW.
  //
  // Measured on 2026-09-08: 8 of 30 abandoned carts are $300+ and they hold 57%
  // of every dollar this store has had walk out, while 12 carts under $100 hold
  // 13%. One flat offer under-serves the carts that matter and over-serves the
  // ones that do not — so the gift, and whether a percentage rides with it, come
  // from the cart's own band.
  const tiers = context.tiers ?? DEFAULT_RECOVERY_TIERS;
  const tier = tierForCart(tiers, context.cartValueCents);

  // The code floor stands whatever the bands say. It is a safety rail rather
  // than a marketing setting, so it is not configurable and it is checked here
  // as well as in the band validator.
  const giftBlocked =
    context.cartValueCents < RECOVERY_GIFT_MIN_CART_CENTS
      ? `cart below the $${(RECOVERY_GIFT_MIN_CART_CENTS / 100).toFixed(0)} gift floor`
      : !tier
        ? "cart below the lowest configured band"
        : withinCooldown(context.lastRecoveryGiftAt, RECOVERY_GIFT_COOLDOWN_MS, context.now)
          ? "gift already given to this address in the last 30 days"
          : null;

  const giftsFor = (stage: "t24h" | "t72h"): RecoveryGiftItem[] => {
    if (giftBlocked || !tier) return [];
    return stage === "t24h" ? tier.stage3 : tier.stage4.gifts;
  };

  if (context.stage === "t24h") {
    // THE GIFT COMES BEFORE THE PERCENTAGE, AND THAT ORDER IS MEASURED. A
    // free-product line is added by quoteOrder independently of the discount
    // slot; a percentage competes for that slot against the live promotion and
    // can lose outright. With Buy 2 Get 1 running, 10% was worth exactly $0 to
    // Heath's cart and to Nikki's. The gift lands whatever else is running.
    const gifts = giftsFor("t24h");
    return {
      offerKey: gifts.length > 0 ? (RECOVERY_GIFT_OFFER_KEY as OfferKey) : null,
      gifts,
      coupon: false,
      percent: 0,
      reason: gifts.length > 0
        ? `stage 3: free gift (${describeGifts(gifts)}), no discount`
        : `no gift: ${giftBlocked ?? "this band gives none at 24h"}`,
      suppressed: false,
    };
  }

  // t72h. The last note about this cart, and the only place a percentage
  // appears — the most expensive thing in the sequence, on the message that
  // follows three the shopper has already ignored.
  //
  // The band decides whether it appears at all. The two bands that carry no
  // percentage are not an oversight: on a small cart a discount adds a few
  // dollars of perceived value for a few dollars of cost, and on a large one it
  // costs far more than the extra product it could have bought instead.
  const gifts = giftsFor("t72h");
  const bandPercent = tier?.stage4.percent ?? 0;

  const couponBlocked = bandPercent <= 0
    ? "this band carries no discount"
    : context.discountPercent <= 0
      ? "operator has the recovery discount switched off"
      : withinCooldown(context.lastRecoveryCouponAt, RECOVERY_GIFT_COOLDOWN_MS, context.now)
        ? "code already given to this address in the last 30 days"
        : null;

  const parts = [
    gifts.length > 0 ? `free gift (${describeGifts(gifts)})` : `no gift (${giftBlocked ?? "this band gives none at 72h"})`,
    couponBlocked ? `no code (${couponBlocked})` : `${bandPercent}% code`,
  ];
  return {
    offerKey: gifts.length > 0 ? (RECOVERY_GIFT_OFFER_KEY as OfferKey) : null,
    gifts,
    coupon: !couponBlocked,
    percent: couponBlocked ? 0 : bandPercent,
    reason: `stage 4: ${parts.join(" + ")}`,
    suppressed: false,
  };
}

/** Gift items in the words an operator reads in the sweep log and the admin. */
function describeGifts(gifts: RecoveryGiftItem[]): string {
  return gifts
    .map((item) => (item.quantity > 1 ? `${item.quantity}x ${item.slug}` : item.slug))
    .join(" + ");
}

/**
 * The gift a band's item list actually mints, as a config the offer engine can
 * write onto a row.
 *
 * WHY IT IS BUILT HERE RATHER THAN LOOKED UP. OFFER_CATALOG holds gifts whose
 * terms were argued about once and written down; a banded recovery gift is
 * assembled from whatever the operator configured for that cart size, so there
 * is no catalogue entry to point at. The row records what was promised, which
 * is the only thing the checkout reads — so an assembled gift redeems through
 * exactly the same locked, email-bound, one-per-customer path as a catalogue
 * one.
 *
 * `names` maps slug to the product's real name, so the label reads "GLOW +
 * GHK-Cu + Recon Water" rather than a list of slugs. A slug missing from it falls
 * back to the slug itself: an ugly label is a cosmetic problem, while
 * withholding the gift over a missing name would be a real one.
 *
 * The minimum and the lifetime are the programme's, not the band's. They are
 * safety rails — the floor that stops a gift being farmed on a tiny order, and
 * the window that stops a liability sitting open — and an operator editing what
 * a band gives should not be able to move either by accident.
 */
export function recoveryGiftConfig(
  gifts: RecoveryGiftItem[],
  names: ReadonlyMap<string, string>,
  percent = 0,
): GiftConfig | null {
  if (gifts.length === 0) return null;
  const label = gifts
    .map((item) => {
      const name = names.get(item.slug) ?? item.slug;
      return item.quantity > 1 ? `${item.quantity} × ${name}` : name;
    })
    .join(" + ");
  const items = gifts.map((item) => ({ slug: item.slug, quantity: item.quantity, variantId: null }));
  return {
    label,
    reward: percent > 0
      ? { kind: "free_products_percent", items, percent }
      : { kind: "free_products", items },
    minSubtotalCents: RECOVERY_GIFT_MIN_CART_CENTS,
    ttlDays: RECOVERY_GIFT_TTL_DAYS,
  };
}
