// No `server-only`, deliberately. Every surface that names the offer is a
// Client Component — the invitation modal, the catalogue bar, the product-page
// link, the cart card, the checkout panel and the account page — and the route
// that mints the code answers with the same sentences. One definition, so the
// offer cannot be described two ways in two places, and a change to the terms
// cannot land on five surfaces and miss the sixth.

/**
 * THE WELCOME OFFER IS EARNED BY JOINING THE TEXT LIST.
 *
 * It was an email offer for one afternoon. The owner moved it on 2026-09-16
 * with the number that settles it: of 193 accounts, 114 were already on the
 * email list and 107 carried marketing_emails, while the SMS list stood at
 * exactly zero. Fifteen per cent for an address the store already holds buys
 * nothing; the same fifteen per cent for a mobile number opens a channel that
 * does not exist yet. The email box keeps its own place at the sign-in gate
 * and at the checkout, with no discount attached to it, and the two consents
 * never imply one another.
 *
 * CONSENT IS NEVER A CONDITION OF PURCHASE. The discount is an incentive to
 * subscribe, not a toll on checking out: every box carrying it is optional,
 * unticked, and sits beside the store's full disclosure (sms-consent-text.ts,
 * the wording the carrier review saw). Nothing in the checkout needs it.
 *
 * WHAT THE TEXTS PROMISE, WE HAVE TO SEND. "Giveaways" and "free product
 * offers" are the owner's words for future promotional opportunities, not a
 * guarantee of a free product for subscribing, and the copy is written so a
 * subscriber cannot read it the other way. It is still a commitment: a list
 * told to expect those and then sent only restock notices is a list that
 * unsubscribes, and the same wording has to match the campaign use case
 * registered with the carriers.
 */

/** What the code takes off, and for how long. Pinned against codes.ts in test. */
export const WELCOME_OFFER_PERCENT = 15;
export const WELCOME_OFFER_DAYS = 14;

// ---------------------------------------------------------------------------
// THE INVITATION. One headline, one supporting line, one field, one button.
// ---------------------------------------------------------------------------

export const SMS_INVITE_HEADLINE = `Get ${WELCOME_OFFER_PERCENT}% off your first order`;

export const SMS_INVITE_BODY =
  "Join Vanta Labs texts for exclusive sales, restock alerts, giveaways, and free product offers.";

export const SMS_INVITE_FIELD_LABEL = "Mobile number";

export const SMS_INVITE_BUTTON = `Get my ${WELCOME_OFFER_PERCENT}% off`;

/**
 * THE TERMS, SHOWN BEFORE THE BUTTON IS PRESSED, NEVER AFTER.
 *
 * All three restrictions in one line: first order only, fourteen days, no
 * stacking. A subscriber who finds out about any of them at the till has been
 * sold something different from what they agreed to.
 */
export const WELCOME_OFFER_TERMS =
  `First order only. Valid for ${WELCOME_OFFER_DAYS} days. Cannot be combined with other offers.`;

// ---------------------------------------------------------------------------
// THE QUIET PLACEMENTS.
// ---------------------------------------------------------------------------

/** The catalogue bar: the offer and the ask in one line. */
export const SMS_BAR_TEXT =
  `Get ${WELCOME_OFFER_PERCENT}% off your first order — join our text list`;

/** The product page: a question under the purchase controls, not a banner. */
export const SMS_PRODUCT_LINK =
  `First order? Get ${WELCOME_OFFER_PERCENT}% off when you join our text list`;

/** The cart, beside the money, where the total is being weighed. */
export const SMS_CART_TEXT =
  `Get ${WELCOME_OFFER_PERCENT}% off this order when you join our text list`;

// ---------------------------------------------------------------------------
// THE CHECKOUT.
// ---------------------------------------------------------------------------

/** The box itself. What the texts are, in the shopper's words, not the lawyer's. */
export const SMS_CHECKOUT_CHECKBOX =
  "Text me about free product offers, exclusive sales, giveaways, and restock alerts.";

/** The incentive, beside the box, for someone the offer is actually open to. */
export const SMS_CHECKOUT_INCENTIVE =
  `Subscribe to get ${WELCOME_OFFER_PERCENT}% off this order. Cannot be combined with other offers.`;

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

/** Ticked the box, no number in the field yet. */
export const SMS_CHECKOUT_NEEDS_PHONE =
  `Add your mobile number above to take ${WELCOME_OFFER_PERCENT}% off this order.`;

// ---------------------------------------------------------------------------
// AFTER A SUCCESSFUL SIGN-UP, AND FOR PEOPLE THE OFFER IS NOT FOR.
// ---------------------------------------------------------------------------

export const SMS_SUCCESS_HEADLINE = "You are on the list";

export const SMS_SUCCESS_BODY =
  "Your code is below. It is saved to your account, so you do not need to write it down.";

export const SMS_COPY_BUTTON = "Copy code";
export const SMS_COPIED_LABEL = "Copied";
export const SMS_CONTINUE_BUTTON = "Continue shopping";

/** The code someone already holds, met again on another surface. */
export const WELCOME_OFFER_READY =
  `Your ${WELCOME_OFFER_PERCENT}% welcome code is ready`;

/**
 * A PREVIOUS BUYER IS NEVER SHOWN A FIRST-ORDER DISCOUNT.
 *
 * They are still worth inviting, so the invitation survives without the
 * number attached to it. Advertising a discount they cannot have is the
 * fastest way to make an offer feel like a trick.
 */
export const SMS_RETURNING_INVITE =
  "Join our text list for exclusive sales, restock alerts and giveaways.";

/** Why the offer is not on screen. Used where an explanation helps. */
export const WELCOME_OFFER_FIRST_ORDER_ONLY =
  "The welcome offer is for a first order.";

/**
 * THE ONE SENTENCE, for surfaces that want the offer and the terms together.
 *
 * BUILT WITH `+` FROM TWO FOLDED HALVES, NOT AS ONE TEMPLATE PAIR, and that is
 * load-bearing. Written as two template literals added together, the minifier
 * folded the pair and dropped the first one's trailing text — the bundle
 * shipped "Get 15Valid for 14 days." Each half is a standalone template that
 * folds correctly on its own; joining identifiers leaves nothing to lose.
 * Guarded by constant-template-folding.test.ts.
 */
export const WELCOME_OFFER_SENTENCE = SMS_INVITE_HEADLINE + ". " + WELCOME_OFFER_TERMS;

/** The code itself, once it exists. */
export function welcomeOfferCodeLine(code: string): string {
  return `Your code is ${code}.`;
}
