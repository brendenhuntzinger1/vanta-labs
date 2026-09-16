import { SPIN_PRIZES, SPIN_TTL_DAYS, type SpinPrize } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// WHAT THE CUSTOMER IS TOLD BEFORE THEY SPIN.
//
// Every number here is DERIVED from SPIN_PRIZES rather than typed beside it.
// That is the whole point of the file: a hand-written odds table is correct on
// the day it is written and wrong the first time a wedge changes, and the
// customer has no way to know which day they are looking at. Deriving it means
// the disclosure cannot drift from the wheel, and the wheel cannot drift from
// the till (the prize table is the same list quoteOrder honours).
//
// THE STACKING RULES ARE READ OFF quote-order.ts, NOT INVENTED HERE.
// They are stated as three separate rules because the three reward shapes
// genuinely behave differently, and a single blanket sentence would be false
// for two of them:
//
//   free_product   a $0 line. It never enters resolveCustomerDiscount, so it
//                  applies ON TOP of a referral, bulk, ambassador or coupon
//                  discount. (quote-order.ts — the $0 line is added directly.)
//
//   free_shipping  waives the fee only where a fee would otherwise be charged
//                  (quote-order.ts:1427 — `!shippingOtherwiseWaived &&
//                  shippingAtListTerms > 0`). Also outside the discount
//                  competition, so it stacks; worth nothing at or above the
//                  store's own free-shipping threshold.
//
//   percent        fills the COUPON SLOT (quote-order.ts:1395-1406), keeping
//                  whichever is larger between the gift and a typed code — a
//                  tie goes to the typed code so the gift is not spent for
//                  nothing. That slot then competes in resolveBestDiscount
//                  against bulk savings, Buy-3-Get-1, referral, member pricing
//                  and the ambassador personal discount, and the single largest
//                  wins. So a percentage prize does NOT stack.
// ---------------------------------------------------------------------------

export type PrizeOdds = {
  prize: SpinPrize;
  /** 1 in `oneIn`. Every wedge is drawn with equal probability. */
  oneIn: number;
  /** The same thing as a percentage, rounded for display. */
  percent: number;
  minSubtotalCents: number;
};

/**
 * The published odds.
 *
 * Uniform by construction: the draw asks for one index across the whole table
 * and every wedge is one entry, so each is exactly 1/n. There is no weights
 * column anywhere in this feature, which is what makes "each prize is equally
 * likely" a fact about the code rather than a claim about it.
 */
export function spinOdds(): PrizeOdds[] {
  const total = SPIN_PRIZES.length;
  return SPIN_PRIZES.map((prize) => ({
    prize,
    oneIn: total,
    percent: Number(((1 / total) * 100).toFixed(2)),
    minSubtotalCents: prize.minSubtotalCents,
  }));
}

/** Distinct minimum spends on the wheel, ascending — the tiers, derived. */
export function spinMinimumTiers(): number[] {
  return Array.from(new Set(SPIN_PRIZES.map((prize) => prize.minSubtotalCents))).sort((a, b) => a - b);
}

export const SPIN_EXPIRY_HOURS = SPIN_TTL_DAYS * 24;

/**
 * The terms, in the customer's words, shown BEFORE the wheel is spun.
 *
 * Read by the page and asserted by the test beside it, so a rule cannot be
 * changed in code without the sentence changing with it.
 */
export const SPIN_TERMS: readonly string[] = [
  "Every spin wins. There are no losing wedges.",
  `Each prize is equally likely — 1 in ${SPIN_PRIZES.length}.`,
  "One spin per customer for this campaign. The result is saved and final.",
  `Your prize expires ${SPIN_EXPIRY_HOURS} hours after you spin.`,
  "Every prize needs a qualifying order — the minimum is shown on each prize below.",
  "A free product is added on top of any other discount you already have.",
  "A percentage prize replaces your other discounts rather than adding to them — you keep whichever is worth more.",
  "Free shipping applies only where shipping would otherwise be charged.",
  "Prizes have no cash value and cannot be transferred or exchanged.",
];

export function formatMoneyFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** What one prize requires, as a sentence for the reveal card and the list. */
export function describeRedemptionCondition(prize: SpinPrize): string {
  const minimum = prize.minSubtotalCents > 0
    ? `on orders of ${formatMoneyFromCents(prize.minSubtotalCents)} or more`
    : "on any order";

  if (prize.reward.kind === "percent") {
    return `${minimum}. Replaces other discounts — you keep whichever is worth more.`;
  }
  if (prize.reward.kind === "free_shipping") {
    return `${minimum}, where shipping would otherwise be charged.`;
  }
  return `${minimum}. Added on top of any other discount.`;
}
