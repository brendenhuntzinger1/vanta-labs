/**
 * How much store credit and how many points come off one order.
 *
 * ONE COPY, THREE CALLERS. `cart-context.tsx` (the drawer and the cart page),
 * `checkout/page.tsx` (which posts the total as `expectedTotal`) and
 * `quote-order.ts` (what the card is actually charged) each carried their own
 * hand-written version of this arithmetic. They have to agree exactly: the
 * server refuses a client total LOWER than its own — "Altered total detected",
 * which then tells the shopper to refresh a page that will recompute the same
 * number — and the express lane sends no `expectedTotal` at all, so a
 * divergence there charges the wallet silently for a figure no screen showed.
 *
 * An adversarial review demonstrated the predictable result: reverting the
 * server's referral gate on its own left all 4,147 tests green, and reverting
 * both client gates on their own did too. Nothing renders `CartProvider`, so
 * nothing saw the client half; nothing passed a referral code into `quoteOrder`
 * alongside a store-credit balance, so nothing saw the server half. Either side
 * of a two-sided money rule could move alone with the suite still green.
 *
 * CENTS, NOT DOLLARS. The balance is stored in cents and the server has always
 * compared in cents; the two clients compared in dollars, which is a rounding
 * disagreement waiting to be found by a total like $54.995.
 */

/** A finite, non-negative integer number of cents. Anything else is 0. */
function cents(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

/**
 * Membership store credit auto-applies once the MERCHANDISE subtotal meets the
 * tier's redemption minimum — the margin guardrail. Measured on merchandise
 * alone on purpose: shipping and tax would push a small order over the
 * threshold without the store earning any more on the goods.
 *
 * `redeemableCents` is what is still owed at this point in the order — credit
 * is deducted before points, so points then compete only for what is left.
 */
export function resolveStoreCreditCents(input: {
  /**
   * The referral is the discount actually coming off this basket.
   *
   * NOT "a referral code is attached", and NOT "the basket is big enough".
   * Store credit never stacks with a referral DISCOUNT, and there is nothing to
   * be exclusive of when the referral gives the shopper nothing — a code can be
   * real, its ambassador approved, and its value still exactly $0.00 (below the
   * minimum, a commission-only ambassador, Buy-3-Get-1 taking over, or another
   * candidate winning `resolveCustomerDiscount`). Confiscating her own credit
   * to pay for a $0.00 discount is the harm the rule exists to prevent, not the
   * rule itself.
   */
  referralDiscountApplied: boolean;
  balanceCents: number;
  minOrderCents: number;
  subtotalCents: number;
  redeemableCents: number;
}): number {
  if (input.referralDiscountApplied) {
    return 0;
  }
  const balance = cents(input.balanceCents);
  if (balance <= 0) {
    return 0;
  }
  if (cents(input.subtotalCents) < cents(input.minOrderCents)) {
    return 0;
  }
  return Math.min(balance, cents(input.redeemableCents));
}

/**
 * Loyalty points behave like store credit rather than like a promo code: they
 * stack with a coupon or with Buy-3-Get-1, and are simply capped at the balance
 * still owed. The caller has already clamped `requestedCents` to the shopper's
 * actual point balance.
 *
 * Same referral rule, same reason, as store credit above.
 */
export function resolvePointsRedemptionCents(input: {
  referralDiscountApplied: boolean;
  requestedCents: number;
  redeemableCents: number;
}): number {
  if (input.referralDiscountApplied) {
    return 0;
  }
  return Math.min(cents(input.requestedCents), cents(input.redeemableCents));
}
