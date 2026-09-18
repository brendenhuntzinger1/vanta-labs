// No `server-only`, deliberately. Every surface that names the text list is a
// Client Component — the catalogue bar, the product-page link, the cart card,
// the checkout box and the account page — and the route that records the
// consent answers with the same sentences. One definition, so the ask cannot be
// described two ways in two places, and a change to the terms cannot land on
// four surfaces and miss the fifth.

/**
 * THERE IS NO WELCOME DISCOUNT ANY MORE, AND NOTHING HERE MAY IMPLY ONE.
 *
 * It was 15% off a first order, earned by joining the text list. The owner
 * retired it on 2026-09-18 and replaced it with the spin-to-win wheel, which is
 * a better offer on both sides of the counter: four of its sixteen wedges are a
 * free vial worth up to $119.99 against a $9 saving on a $60 order, and every
 * wedge carries a minimum spend, so the store is paid before it pays out. The
 * wheel is not sold from this module — it has its own card and its own page.
 *
 * WHAT IS LEFT HERE IS THE TEXT LIST, ASKED FOR PLAINLY. The channel is still
 * worth building: of 193 accounts, 114 were already on the email list while the
 * SMS list stood at exactly zero. The ask now stands on what the texts actually
 * are rather than on a discount, which is also the only honest way to put it
 * once there is no discount to attach.
 *
 * CONSENT IS NEVER A CONDITION OF ANYTHING. It was never a condition of
 * purchase; it is now not a condition of an offer either, which is why every
 * box carrying it says "optional" and means it. The wording itself lives in
 * sms-consent-text.ts — the sentence the carrier review saw — and is not
 * restated here.
 *
 * WHAT THE TEXTS PROMISE, WE HAVE TO SEND. "Giveaways" and "free product
 * offers" are the owner's words for future promotional opportunities, not a
 * guarantee of a free product for subscribing, and the copy is written so a
 * subscriber cannot read it the other way. It is still a commitment: a list
 * told to expect those and then sent only restock notices is a list that
 * unsubscribes, and the same wording has to match the campaign use case
 * registered with the carriers.
 */

/**
 * What a HISTORICAL code takes off, and for how long. Pinned against codes.ts
 * in test.
 *
 * Nothing mints one now. These survive because the people who took the offer
 * before it was retired still hold live codes, and the surfaces that show a
 * holder their own code have to describe it correctly — welcome-offer.ts reads
 * the live code BEFORE the retirement gate for exactly that reason.
 */
export const WELCOME_OFFER_PERCENT = 15;
export const WELCOME_OFFER_DAYS = 14;

// ---------------------------------------------------------------------------
// THE TEXT-LIST ASK. One headline, one supporting line, one field, one button.
// ---------------------------------------------------------------------------

export const SMS_INVITE_HEADLINE = "Join the Vanta Labs text list";

export const SMS_INVITE_BODY =
  "Join Vanta Labs texts for exclusive sales, restock alerts, giveaways, and free product offers.";

export const SMS_INVITE_FIELD_LABEL = "Mobile number";

export const SMS_INVITE_BUTTON = "Join the list";

/** The catalogue bar: what the texts are, in one line. */
export const SMS_BAR_TEXT =
  "Exclusive sales, restock alerts and giveaways — join our text list";

/** The product page: a question under the purchase controls, not a banner. */
export const SMS_PRODUCT_LINK =
  "Join our text list for restock alerts and giveaways";

// ---------------------------------------------------------------------------
// THE CHECKOUT.
// ---------------------------------------------------------------------------

/**
 * The box itself. What the texts are, in the shopper's words, not the lawyer's.
 *
 * UNCHANGED THROUGH THE RETIREMENT, because it never named a discount. What
 * went is the line that used to sit next to it selling one.
 */
export const SMS_CHECKOUT_CHECKBOX =
  "Text me about free product offers, exclusive sales, giveaways, and restock alerts.";

// ---------------------------------------------------------------------------
// FOR SOMEBODY WHO STILL HOLDS A CODE FROM BEFORE THE RETIREMENT.
//
// None of this is an offer to anyone. Every line below is shown only once the
// server has confirmed a live code on that account.
// ---------------------------------------------------------------------------

/**
 * THE TERMS, SHOWN WITH THE CODE.
 *
 * All three restrictions in one line: first order only, fourteen days, no
 * stacking. A holder who found out about any of them at the till would have
 * been sold something different from what they agreed to.
 */
export const WELCOME_OFFER_TERMS =
  `First order only. Valid for ${WELCOME_OFFER_DAYS} days. Cannot be combined with other offers.`;

/**
 * Only after the quote says so. The checkout decides this from the priced
 * order rather than from the fact that a code was entered.
 */
export const WELCOME_OFFER_APPLIED =
  `Your ${WELCOME_OFFER_PERCENT}% welcome discount is applied`;

/**
 * WHEN SOMETHING BETTER IS ALREADY ON THE ORDER.
 *
 * This used to end "so your welcome code is saved for a future order", which
 * was not true and was the kind of untrue that costs a customer: completing
 * this order makes them a buyer, and a buyer's welcome code is retired at
 * first payment (order-hooks.ts). The store was promising a future it was
 * about to remove. It now states the real choice and the real consequence.
 */
export const WELCOME_OFFER_HELD_BY_BETTER =
  "A larger discount is already on this order, and offers cannot be combined. "
  + "Keep it, or remove it to use your welcome code instead. "
  + "Either way, completing this order ends the welcome offer.";

/** The code someone already holds, met again on another surface. */
export const WELCOME_OFFER_READY =
  `Your ${WELCOME_OFFER_PERCENT}% welcome code is ready`;

export const SMS_SUCCESS_HEADLINE = "You are on the list";

export const SMS_SUCCESS_BODY =
  "Your code is below. It is saved to your account, so you do not need to write it down.";

export const SMS_COPY_BUTTON = "Copy code";
export const SMS_COPIED_LABEL = "Copied";
export const SMS_CONTINUE_BUTTON = "Continue shopping";

/** The code itself, once it exists. */
export function welcomeOfferCodeLine(code: string): string {
  return `Your code is ${code}.`;
}
