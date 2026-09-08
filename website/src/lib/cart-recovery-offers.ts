import type { OfferKey } from "@/lib/offers/customer-offers";

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
 * BAC Water is $14.99 retail. Against a $20 basket the gift is a loss dressed
 * as a recovery, and the shopper most likely to take it is the one who was
 * going to buy the $20 anyway. $35 is a little over two vials and matches the
 * floor every other product gift in OFFER_CATALOG already uses.
 */
export const RECOVERY_GIFT_MIN_CART_CENTS = 3_500;

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
  /** The operator's configured recovery discount. Zero means "no discount". */
  discountPercent: number;
  now: number;
}

export interface RecoveryOfferPlan {
  /** The entitlement to mint behind the stage claim, or null for none. */
  offerKey: OfferKey | null;
  /** Whether this stage may carry a percentage coupon. */
  coupon: boolean;
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
    ({ offerKey: null, coupon: false, reason, suppressed: false });

  // STAGES ONE AND TWO CARRY NOTHING, DELIBERATELY. A discount on the first
  // reminder is a discount for having been interrupted, and it teaches the
  // fastest lesson a store can teach: abandon the cart and wait.
  if (context.stage === "t30m") return none("reminder only: no incentive at stage 1");
  if (context.stage === "t12h") return none("reassurance only: no incentive at stage 2");

  // A recent buyer is inside a reorder cycle. Paying them changes nothing they
  // were not already going to do, and it is the most expensive kind of
  // discount because it converts at exactly the rate of no discount at all.
  if (withinCooldown(context.lastPaidAt, RECOVERY_RECENT_BUYER_MS, context.now)) {
    return none("no incentive: recent buyer inside their own reorder cycle");
  }

  const giftBlocked =
    context.cartValueCents < RECOVERY_GIFT_MIN_CART_CENTS
      ? `cart below the $${(RECOVERY_GIFT_MIN_CART_CENTS / 100).toFixed(0)} gift floor`
      : withinCooldown(context.lastRecoveryGiftAt, RECOVERY_GIFT_COOLDOWN_MS, context.now)
        ? "gift already given to this address in the last 30 days"
        : null;

  const offerKey = giftBlocked ? null : (RECOVERY_GIFT_OFFER_KEY as OfferKey);

  if (context.stage === "t24h") {
    // THE GIFT COMES BEFORE THE PERCENTAGE, AND THAT ORDER IS MEASURED. A
    // free-product line is added by quoteOrder independently of the discount
    // slot; a percentage competes for that slot against the live promotion and
    // can lose outright. With Buy 2 Get 1 running, 10% was worth exactly $0 to
    // Heath's cart and to Nikki's. The gift lands whatever else is running.
    return {
      offerKey,
      coupon: false,
      reason: offerKey ? "stage 3: free gift, no discount" : `no gift: ${giftBlocked}`,
      suppressed: false,
    };
  }

  // t72h. The last note about this cart, and the only place a percentage
  // appears — the most expensive thing in the sequence, on the message that
  // follows three the shopper has already ignored.
  const couponBlocked = context.discountPercent <= 0
    ? "operator has the recovery discount set to zero"
    : withinCooldown(context.lastRecoveryCouponAt, RECOVERY_GIFT_COOLDOWN_MS, context.now)
      ? "code already given to this address in the last 30 days"
      : null;

  const parts = [
    offerKey ? "free gift" : `no gift (${giftBlocked})`,
    couponBlocked ? `no code (${couponBlocked})` : `${context.discountPercent}% code`,
  ];
  return {
    offerKey,
    coupon: !couponBlocked,
    reason: `stage 4: ${parts.join(" + ")}`,
    suppressed: false,
  };
}
