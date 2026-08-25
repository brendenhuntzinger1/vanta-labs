// "Only one discount per order, greatest savings wins" - shared by the
// client cart preview and the server checkout total so both always agree
// on which single discount is actually applied.
//
// That claim was HALF TRUE and the untrue half cost a correct cart total. The
// server does not call resolveBestDiscount; it calls resolveCustomerDiscount in
// profit-engine.ts. The two only agree if they assemble the same candidates,
// and the cart's assembly lived inline in cart-context.tsx where nothing could
// import it — so nothing could test it, and it drifted: the coupon sat on the
// third rung of a priority chain that a Buy-3-Get-1 bundle short-circuited,
// while the server let bundle and coupon compete. $20 free item + $50 coupon
// showed $20 off and charged $50 off.
//
// resolveCartDiscount below is that assembly, lifted out. The cart calls it and
// the parity suite calls it, so "the price shown is the price charged" is now a
// property of one function two callers share rather than of two hand-written
// copies that happened to match on the day they were written.

export type DiscountType = "bulk_savings" | "buy3get1" | "referral" | "coupon" | "member_pricing" | "ambassador_personal";

export interface DiscountCandidate {
  type: DiscountType;
  amount: number;
}

export function resolveBestDiscount(candidates: DiscountCandidate[]): DiscountCandidate | null {
  let best: DiscountCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.amount > 0 && (!best || candidate.amount > best.amount)) {
      best = candidate;
    }
  }
  return best;
}

/** Everything the cart knows that can reduce what a shopper pays. */
export interface CartDiscountInputs {
  /** Cart total AFTER quantity-bundle pricing is already baked in. */
  subtotal: number;
  /** Savings quantity-bundle pricing already granted inside `subtotal`. */
  quantityBundleSavings: number;
  bulkSavingsAmount: number;
  memberPricingAmount: number;
  ambassadorPersonalAmount: number;
  couponDiscountAmount: number;
  /**
   * The Buy-3-Get-1 free item, or a valid referral — never both, and never
   * alongside the coupon. A bundle suppresses the referral outright, matching
   * `!isBundle && hasReferral` in profit-engine's resolveCustomerDiscount.
   */
  promo: DiscountCandidate | null;
}

export interface CartDiscountResult {
  /** The single winning discount, or null when nothing applies. */
  best: DiscountCandidate | null;
  /** What comes off the cart: the winner, floored at 0 and capped at subtotal. */
  amount: number;
}

/**
 * The one discount the cart applies, chosen the way the server chooses it.
 *
 * Each candidate competes on what it saves BEYOND bundle pricing already in the
 * subtotal, which is what `compete` does here and what `compete` does in
 * resolveCustomerDiscount. With no bundle savings it is the identity, so an
 * ordinary cart is unaffected.
 */
export function resolveCartDiscount(inputs: CartDiscountInputs): CartDiscountResult {
  const round = (value: number) => Math.round(value * 100) / 100;
  const alreadyGranted = Math.max(0, inputs.quantityBundleSavings);
  const compete = (raw: number) => Math.max(0, round(raw - alreadyGranted));

  const best = resolveBestDiscount([
    { type: "bulk_savings", amount: compete(inputs.bulkSavingsAmount) },
    { type: "member_pricing", amount: compete(inputs.memberPricingAmount) },
    { type: "ambassador_personal", amount: compete(inputs.ambassadorPersonalAmount) },
    ...(inputs.promo ? [{ type: inputs.promo.type, amount: compete(inputs.promo.amount) }] : []),
    // On its own footing, never behind the promo. This is the fix.
    { type: "coupon" as const, amount: compete(inputs.couponDiscountAmount) },
  ]);

  return { best, amount: round(Math.min(inputs.subtotal, best?.amount ?? 0)) };
}
