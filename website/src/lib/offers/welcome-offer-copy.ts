// No `server-only`, deliberately. Every surface that names the welcome offer
// is a Client Component — the catalogue bar, the product-page link, the cart
// card, the checkout box — and the route that mints the code answers with the
// same sentences. One definition, so the offer cannot be described two ways in
// two places, and a change to the terms cannot land on three surfaces and miss
// the fourth.

/**
 * THE WELCOME OFFER IS EARNED BY A TEXT SUBSCRIPTION, NOT AN EMAIL ONE.
 *
 * It was an email offer for one afternoon. The owner moved it on 2026-09-16
 * with the number that settles it: of 193 accounts, 114 are already on the
 * email list and 107 carry marketing_emails, while the SMS list stood at
 * exactly zero. Fifteen per cent for an address the store already holds buys
 * nothing it does not have; the same fifteen per cent for a mobile number
 * opens a channel that does not exist yet. The email box keeps its own place
 * at sign-up and at checkout, with no discount attached to it.
 *
 * CONSENT IS STILL NEVER A CONDITION OF PURCHASE. The discount is an
 * incentive to subscribe, not a toll on checking out: every box carrying it
 * is optional, unticked, and sits beside the store's TCPA sentence
 * (sms-consent-text.ts, the wording the A2P review saw). Nothing in the
 * checkout needs it to take payment, and the offer is never shown as a step.
 *
 * THE SAME CODE EVERYWHERE. Each surface reads and mints through one service
 * (welcome-offer.ts → codes.ts ensureContactCode), so a subscriber who
 * already holds a live code is handed that one again — never a second code,
 * never a fresh fourteen days — and someone who has already bought is not
 * shown the offer at all.
 */

/** What the code takes off, and for how long. Pinned against codes.ts in test. */
export const WELCOME_OFFER_PERCENT = 15;
export const WELCOME_OFFER_DAYS = 14;

/** The terms half alone, for surfaces that show the headline separately. */
export const WELCOME_OFFER_TERMS =
  `Valid for ${WELCOME_OFFER_DAYS} days. Cannot be combined with other offers.`;

/** The headline half alone. */
export const WELCOME_OFFER_HEADLINE =
  `Subscribe to texts for ${WELCOME_OFFER_PERCENT}% off your first order.`;

/**
 * THE ONE SENTENCE. Every placement opens with exactly this, so the catalogue,
 * a product page, the cart and the checkout make the same promise in the same
 * words. Terms travel with the offer rather than trailing it in small print.
 *
 * BUILT FROM THE TWO HALVES WITH `+`, NOT AS ONE TEMPLATE PAIR, and that is
 * load-bearing. It was written as two template literals added together:
 *
 *     `Subscribe to texts for ${PERCENT}% off your first order. `
 *     + `Valid for ${DAYS} days. Cannot be combined...`
 *
 * The unit test passed, and the production bundle shipped "Subscribe to texts
 * for 15Valid for 14 days." — the minifier folded the pair and dropped the
 * first template's trailing quasi, the "% off your first order. " that is the
 * entire offer. It survives a dev run and every test, because neither
 * minifies, and it was caught only by reading the rendered page (2026-09-17).
 * Each half is now a standalone template that folds correctly on its own, and
 * joining identifiers leaves nothing for the folder to lose.
 */
export const WELCOME_OFFER_SENTENCE = WELCOME_OFFER_HEADLINE + " " + WELCOME_OFFER_TERMS;

/** The discreet product-page opener: a question, not a banner. */
export const WELCOME_OFFER_LINK_LABEL =
  `First order? Get ${WELCOME_OFFER_PERCENT}% off when you subscribe to texts`;

/** What replaces the ask once the code exists but is not yet on an order. */
export const WELCOME_OFFER_READY =
  `Your ${WELCOME_OFFER_PERCENT}% welcome code is ready`;

/** What replaces the ask once the code is on the order. */
export const WELCOME_OFFER_APPLIED =
  `Your ${WELCOME_OFFER_PERCENT}% welcome discount is applied`;

/**
 * What the shopper is told when something better is already on the order.
 * The better discount is never disturbed to make room for this one; the code
 * keeps its remaining days and its own terms explain why both cannot run.
 */
export const WELCOME_OFFER_HELD_BY_BETTER =
  "A larger discount is already applied to this order. Offers cannot be combined, "
  + "so your welcome code is saved for a future order.";

/** Shown beside the box that earns the code, under the TCPA sentence. */
export const WELCOME_OFFER_CHECKOUT_PROMPT =
  `Add your mobile number above and tick the box to take ${WELCOME_OFFER_PERCENT}% off this order.`;

/** The code itself, once it exists. */
export function welcomeOfferCodeLine(code: string): string {
  return `Your code is ${code}. It is saved to your account, so you do not need to write it down.`;
}

/** Why the offer is not on screen for someone who has already bought. */
export const WELCOME_OFFER_FIRST_ORDER_ONLY =
  "The welcome offer is for a first order.";
