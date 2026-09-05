/**
 * Does this basket qualify for an ambassador's referral discount?
 *
 * ONE RULE, TWO SIDES — the same reason `resolveAmbassadorCustomerDiscount`
 * lives in its own module. The cart preview, `quote-order.ts` (what the card is
 * charged) and `payment-webhook.ts` (what the ambassador is paid) each used to
 * carry their own copy of `subtotal < minimumQualifyingOrder`. Three copies of a
 * money rule drift, and the drift is invisible: the customer is quoted one
 * price and charged another, or the customer gets the discount and the
 * ambassador silently earns nothing on the same order.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT.
 *
 * It answers only "is this basket big enough". It knows nothing about whether
 * the code exists, whether the ambassador is approved, or whether the shopper is
 * referring themselves — those are separate questions with separate answers, and
 * keeping them separate is what stops one of them quietly standing in for
 * another.
 *
 * NOT QUALIFYING IS NOT AN ERROR. A basket under the minimum earns no discount
 * and no commission, and the sale still goes through. That distinction is the
 * whole point of this module: `quote-order.ts` used to THROW here, which turned
 * an ambassador's own link into a checkout blocker for any basket under $100 —
 * while the code ten lines above it dropped a *stale* referral rather than
 * throwing, on the stated grounds that "a stale referral must never hard-block a
 * legitimate sale". A perfectly valid code that merely arrived with a small
 * basket deserves at least that.
 */

/**
 * Cents, not dollars.
 *
 * A subtotal is a sum of per-line totals that have each been through per-unit
 * floor rounding, so it can land a sub-cent hair either side of a round number.
 * Comparing `99.999999999 >= 100` refuses a basket that is, to the cent,
 * exactly on the minimum. Both sides are rounded to cents before comparison so
 * the boundary is stable and means what it says.
 */
function toCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * The programme minimum in cents, or 0 for "no minimum".
 *
 * A corrupt stored minimum resolves to NO minimum, never to an impossible one.
 * The failure mode being avoided is the silent one: an unusable value that made
 * every basket fail to qualify would strip the discount from every ambassador's
 * customers while the code kept working and nothing errored — nobody would find
 * out until an ambassador asked why her audience stopped converting. That is the
 * same reasoning `resolveAmbassadorCustomerDiscount` applies to a corrupt rate.
 */
function minimumCents(minimumQualifyingOrder: number): number {
  if (!Number.isFinite(minimumQualifyingOrder) || minimumQualifyingOrder <= 0) {
    return 0;
  }
  return toCents(minimumQualifyingOrder);
}

/**
 * True when the basket is at least the programme minimum.
 *
 * `subtotal` is the MERCHANDISE subtotal after quantity-bundle pricing — the
 * same figure `quote-order.ts` gates on and the same one the cart shows. A
 * non-finite subtotal is a bug in the caller, not a request for a discount, so
 * it does not qualify.
 */
export function referralQualifies(subtotal: number, minimumQualifyingOrder: number): boolean {
  // Finiteness FIRST. When this sat below the no-minimum shortcut,
  // referralQualifies(NaN, 0) returned true and contradicted the contract
  // directly above. A corrupt subtotal is a corrupt subtotal whatever the
  // programme minimum happens to be.
  if (!Number.isFinite(subtotal)) {
    return false;
  }
  const minimum = minimumCents(minimumQualifyingOrder);
  if (minimum === 0) {
    return true;
  }
  return toCents(subtotal) >= minimum;
}

/**
 * How much more the customer must spend before the code applies, in dollars.
 *
 * Zero once the basket qualifies. This exists so the cart can say "add $60.01 to
 * qualify" instead of announcing a discount it is not going to give.
 */
export function referralShortfall(subtotal: number, minimumQualifyingOrder: number): number {
  const minimum = minimumCents(minimumQualifyingOrder);
  if (minimum === 0) {
    return 0;
  }
  const have = Number.isFinite(subtotal) ? toCents(subtotal) : 0;
  return have >= minimum ? 0 : (minimum - have) / 100;
}

/**
 * The one sentence the cart, the drawer and the checkout panel all show about an
 * attached referral code.
 *
 * It lives here because it is a promise about money, and three hand-written
 * copies of a promise about money is how the three come to say different things.
 *
 * The non-qualifying wording deliberately never contains the words "customer
 * discount": the defect this replaces rendered
 * "Ambassador Xavier Martinez • 15% customer discount" on a $39.99 basket that
 * was about to be charged in full, and the shopper had no way to know why. It
 * names the threshold and the exact shortfall instead, so the sentence is both
 * true and actionable.
 */
export function referralStatusLine(input: {
  ambassadorName: string;
  discountPercent: number;
  meetsMinimum: boolean;
  amountToQualify: number;
  minimumOrder: number;
  formatCurrency: (value: number) => string;
  /**
   * The referral is the discount actually coming off this basket.
   *
   * NOT "the basket is big enough". The referral competes against every other
   * candidate in `resolveCustomerDiscount` and loses to several of them, at
   * which point it is worth exactly $0.00 on a basket that clears the minimum
   * — see the module note on `referralCartStatus`.
   */
  referralDiscountApplied?: boolean;
  /** Some OTHER discount is what the shopper is getting instead. */
  competingDiscountApplied?: boolean;
  /**
   * Customer-facing name of the discount that beat this code, e.g. "Bundle
   * pricing", "Promo code SAVE20". Named in the sentence so a shopper whose
   * ambassador code took nothing off can see WHY, and see that it is because
   * they are getting something better rather than because the code failed.
   *
   * The coupon side of the cart has said this since describeCouponOutcome
   * landed — "SAVE20 accepted — but your Bundle pricing saves you more, so we
   * kept that." The referral side said only "Robin · referral code applied",
   * which is true and tells the shopper nothing about the contest they just
   * won. Optional: with no label the sentence falls back to that wording.
   */
  competingDiscountLabel?: string | null;
}): string {
  const { discountPercent, meetsMinimum, amountToQualify, minimumOrder, formatCurrency } = input;
  const referralDiscountApplied = input.referralDiscountApplied ?? false;
  const competingDiscountApplied = input.competingDiscountApplied ?? false;
  // `ambassador_name` comes straight off the RPC row and is nullable there.
  // Interpolating it produced the literal words "null" / "undefined" in front of
  // a shopper; the old JSX rendered nothing at all, which was merely odd. Neither
  // is acceptable in a sentence about their money.
  const name = typeof input.ambassadorName === "string" && input.ambassadorName.trim()
    ? input.ambassadorName.trim()
    : "Your ambassador";
  const applied = `${name} · referral code applied`;

  // A COMMISSION-ONLY AMBASSADOR GIVES THE CUSTOMER NOTHING, AT ANY SIZE.
  //
  // customer_discount_percent = 0 is a legitimate configuration — the admin can
  // set it and resolveAmbassadorCustomerDiscount accepts it verbatim. For that
  // code no basket ever "unlocks" anything, so naming a minimum would be a
  // false claim: a $500 order would read "0% off orders of $100.00 or more —
  // add $0.00 to unlock it". Say only what is true.
  if (!(discountPercent > 0)) {
    return applied;
  }
  // CLAIM A DISCOUNT ONLY WHEN ONE IS BEING GIVEN.
  if (referralDiscountApplied) {
    return `${name} · ${discountPercent}% customer discount`;
  }
  // Something else won. "Add $60.01 to unlock it" is advice that cannot unlock
  // anything while that holds, and it is just as wrong above the minimum as
  // below it — so this is checked BEFORE the shortfall wording, not after.
  if (competingDiscountApplied) {
    const winner = input.competingDiscountLabel?.trim();
    // Name it, and say the code is still doing its other job. A shopper who
    // sees their ambassador's code sitting there with no discount beside it
    // reasonably concludes it failed and removes it — which is exactly the act
    // that used to cost the ambassador the commission.
    return winner
      ? `${applied} · your ${winner} saves you more, so we kept that`
      : applied;
  }
  if (meetsMinimum) {
    // Qualifies, nothing else applied, and the referral still won nothing: the
    // quantity-bundle pricing already inside the subtotal competed it to zero.
    // There is no shortfall to name and no discount to promise.
    return applied;
  }
  // "orders OF $100.00 OR MORE", not "orders over $100.00". referralQualifies
  // rounds both sides to cents and compares with `>=`, so a basket of exactly
  // $100.00 qualifies. "Over" describes a threshold this module deliberately
  // does not have, and the shopper who lands on it to the cent is the one person
  // guaranteed to notice.
  return `${name} · ${discountPercent}% off orders of ${formatCurrency(minimumOrder)} or more`
    + ` — add ${formatCurrency(amountToQualify)} to unlock it`;
}

/**
 * What the cart says immediately after the shopper types a code and presses Apply.
 *
 * `applyReferralCode` used to REFUSE a code below the minimum outright — it
 * cleared the code, cleared the details and showed a blocking error. That left
 * the two ways of attaching a code disagreeing with each other: a code that
 * arrived from an ambassador's link stayed attached, and the same code typed by
 * hand was thrown away. Once the server stopped refusing below-minimum orders,
 * the client's refusal disagreed with the server as well, and every shopper who
 * typed a code instead of clicking a link still produced no attribution at all.
 *
 * Apply now accepts the code either way. This says which of the two it is.
 */
export function referralAppliedMessage(input: {
  discountPercent: number;
  meetsMinimum: boolean;
  amountToQualify: number;
  minimumOrder: number;
  formatCurrency: (value: number) => string;
}): string {
  const { discountPercent, meetsMinimum, amountToQualify, minimumOrder, formatCurrency } = input;
  if (meetsMinimum) {
    return `Referral code applied — ${discountPercent}% off.`;
  }
  return `Referral code saved — ${discountPercent}% off unlocks at ${formatCurrency(minimumOrder)}.`
    + ` Add ${formatCurrency(amountToQualify)} to qualify.`;
}

/**
 * Everything the three cart surfaces need to say about an attached referral
 * code, worked out once.
 *
 * `referralStatusLine` takes the answers; this works them out. Before it
 * existed the working-out lived in cart-context.tsx and each of the three
 * surfaces — cart page, drawer, checkout panel — hand-copied six fields into
 * the call. That is the exact shape of the drift `resolveCartDiscount` was
 * extracted to end: a decision inside a React component is a decision nothing
 * can import, so nothing can test it, so the copies diverge.
 *
 * IT TAKES THE OUTCOME, NOT THE BASKET SIZE. The first version of this
 * function was handed the Buy-3-Get-1 amount and treated only that as "the
 * referral is suppressed", because Buy-3-Get-1 was the case in front of me.
 * The referral competes against every candidate in `resolveCustomerDiscount`
 * and loses to several:
 *
 *   - a commission-only ambassador (`customer_discount_percent = 0`)
 *   - Buy-3-Get-1 (`!isBundle && hasReferral` in profit-engine)
 *   - quantity-bundle pricing, through `compete()` — DEFAULT catalogue
 *     pricing, not an opt-in promo. Two units of a $100 item bake $10 of
 *     savings into the subtotal, and a 5% ambassador's $10 competes to
 *     exactly $0.00.
 *   - membership, bulk savings or an ambassador personal discount winning
 *
 * In each of those the basket clears the minimum and the code is worth
 * nothing, and the sentence used to announce "N% customer discount" directly
 * above totals crediting "Bundle pricing". Worse, the same half-answer was
 * what store credit and points were suppressed on, so the shopper lost her own
 * credit to buy a discount of $0.00.
 *
 * So the inputs are the resolved outcome — already computed by
 * `resolveCartDiscount` on the client and `resolveCustomerDiscount` on the
 * server — and nothing is re-derived here.
 */
export function referralCartStatus(input: {
  ambassadorName: string;
  discountPercent: number;
  subtotal: number;
  minimumQualifyingOrder: number;
  /** The referral is the discount actually coming off this basket. */
  referralDiscountApplied: boolean;
  /** Some other discount is what the shopper is getting instead. */
  competingDiscountApplied: boolean;
  /** Customer-facing name of that other discount, for the sentence. */
  competingDiscountLabel?: string | null;
  formatCurrency: (value: number) => string;
}): {
  meetsMinimum: boolean;
  amountToQualify: number;
  referralDiscountApplied: boolean;
  /** The shopper can actually act on this sentence — drives the amber styling. */
  needsMoreToQualify: boolean;
  line: string;
} {
  const {
    ambassadorName, discountPercent, subtotal, minimumQualifyingOrder,
    referralDiscountApplied, competingDiscountApplied, formatCurrency,
  } = input;
  const meetsMinimum = referralQualifies(subtotal, minimumQualifyingOrder);
  const amountToQualify = referralShortfall(subtotal, minimumQualifyingOrder);
  return {
    meetsMinimum,
    amountToQualify,
    referralDiscountApplied,
    // Amber is a call to action. There is none when another discount has taken
    // over and none for a commission-only code, because no basket size changes
    // either.
    needsMoreToQualify: !meetsMinimum && !competingDiscountApplied && discountPercent > 0,
    line: referralStatusLine({
      ambassadorName,
      discountPercent,
      meetsMinimum,
      amountToQualify,
      minimumOrder: minimumQualifyingOrder,
      formatCurrency,
      referralDiscountApplied,
      competingDiscountApplied,
      competingDiscountLabel: input.competingDiscountLabel ?? null,
    }),
  };
}
