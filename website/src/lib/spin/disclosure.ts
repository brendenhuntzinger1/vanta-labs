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
  /** How many wedges grant this same reward. Usually one. */
  wedges: number;
  /** Total wedges on the wheel, the denominator of the odds. */
  outOf: number;
  /** The real chance of this PRIZE, as a percentage, rounded for display. */
  percent: number;
  minSubtotalCents: number;
};

/**
 * Two wedges granting the same thing are ONE prize at twice the odds.
 *
 * SIXTEEN WEDGES IS NOT SIXTEEN PRIZES. "15% off" occupies two wedges, so a
 * list that printed "1 in 16" against each of them told the customer something
 * false twice over: it understated their real chance of a percentage, and it
 * implied fifteen-percent-off and twenty-percent-off were equally likely when
 * one is twice the other.
 *
 * Grouping is by what the reward GRANTS, not by wedge id, because that is what
 * the customer receives and what the till honours.
 */
function rewardIdentity(prize: SpinPrize): string {
  const reward = prize.reward;
  if (reward.kind === "free_product") return `free_product:${reward.productSlug}`;
  if (reward.kind === "percent") return `percent:${reward.percent}:${prize.maxDiscountCents ?? 0}`;
  return reward.kind;
}

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
  const byReward = new Map<string, PrizeOdds>();

  for (const prize of SPIN_PRIZES) {
    const key = rewardIdentity(prize);
    const seen = byReward.get(key);
    if (seen) {
      seen.wedges += 1;
      seen.percent = Number(((seen.wedges / total) * 100).toFixed(2));
      continue;
    }
    byReward.set(key, {
      prize,
      wedges: 1,
      outOf: total,
      percent: Number(((1 / total) * 100).toFixed(2)),
      minSubtotalCents: prize.minSubtotalCents,
    });
  }

  return [...byReward.values()];
}

/** How many DISTINCT prizes the wheel grants. Not the wedge count. */
export function distinctPrizeCount(): number {
  return spinOdds().length;
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
  `Every wedge is equally likely. The wheel has ${SPIN_PRIZES.length} wedges and ${distinctPrizeCount()} prizes, so a prize on two wedges comes up twice as often.`,
  "One spin per customer for this campaign. The result is saved and final.",
  `Your prize expires ${SPIN_EXPIRY_HOURS} hours after you spin.`,
  "Every prize is claimed with a qualifying purchase — your cart will tell you exactly what's needed.",
  // THESE TWO SAY "DISCOUNT CODE", NOT "DISCOUNT", AND THE DIFFERENCE IS REAL.
  //
  // They used to promise it against "any other discount you already have" and
  // "your other discounts". quote-order compares a percentage prize against a
  // typed COUPON CODE (the Math.max in the coupon slot) — it cannot compare it
  // against a second saved reward, because a quote resolves exactly one
  // customer_offers row, the one in the cookie. So for someone already holding
  // a saved reward the promise was one the till could not keep.
  //
  // Measured against the 103-person audience on 2026-09-17: 78 hold a live
  // saved reward, 71 of them an uncapped 15% win-back. The wheel's own 15% is
  // capped at $30, so above a $200 basket "you keep whichever is worth more"
  // would have been false for them.
  //
  // The third line is new and is the honest version of what actually happens.
  "A free product is added on top of any discount code you already have.",
  "A percentage prize replaces a discount code rather than adding to it — you keep whichever is worth more.",
  "If you already have a saved reward from us, spinning replaces it with your prize. The prize is yours from the moment the wheel stops.",
  "Free shipping applies only where shipping would otherwise be charged.",
  "Prizes have no cash value and cannot be transferred or exchanged.",
];

export function formatMoneyFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * What one prize requires, WITHOUT naming the figure.
 *
 * THE NUMBER IS DELIBERATELY NOT HERE, and that is a product decision worth
 * writing down rather than discovering later. A dollar minimum shown beside
 * every wedge reads as a price of entry before anyone has won anything, and it
 * turns people away at the moment the promotion is trying to attract them.
 *
 * What is NOT hidden is the condition itself: every line below says a
 * qualifying purchase is required, and `describeExactCondition` puts the real
 * figures on the same page under "Full terms". A minimum a customer only
 * discovers at the till is the thing that produces "bait and switch"
 * complaints and chargebacks — so it is disclosed, just not shouted.
 *
 * The cart, the drawer and the checkout summary then do the specific ask
 * ("Add $34 more to unlock your free KLOW"), which they already did for every
 * other offer this store mints — see cart-client.tsx, cart-drawer.tsx and
 * checkout/page.tsx. That is the right moment for a number: the customer has
 * a basket, so it is an achievable step rather than a toll.
 */
export function describeRedemptionCondition(prize: SpinPrize): string {
  if (prize.reward.kind === "percent") {
    // The CAP stays, because it is a limit on what they receive rather than a
    // condition of entry. A benefit ceiling discovered at the till is exactly
    // the surprise this whole note is trying to avoid.
    const cap = prize.maxDiscountCents
      ? ` Up to ${formatMoneyFromCents(prize.maxDiscountCents)}.`
      : "";
    return `With a qualifying purchase.${cap} Replaces other discounts — you keep whichever is worth more.`;
  }
  if (prize.reward.kind === "free_shipping") {
    return "With a qualifying purchase, where shipping would otherwise be charged.";
  }
  return "Yours free with a qualifying purchase. Added on top of any other discount.";
}

/** The same condition WITH the figure, for the full-terms disclosure. */
export function describeExactCondition(prize: SpinPrize): string {
  const minimum = prize.minSubtotalCents > 0
    ? `on orders of ${formatMoneyFromCents(prize.minSubtotalCents)} or more`
    : "on any order";

  if (prize.reward.kind === "percent") {
    // The cap is stated wherever it exists. A percentage advertised without its
    // ceiling is the one number on this page a customer could reasonably feel
    // misled by, because they only discover it at the till.
    const cap = prize.maxDiscountCents
      ? ` Up to ${formatMoneyFromCents(prize.maxDiscountCents)}.`
      : "";
    return `${minimum}.${cap} Replaces other discounts — you keep whichever is worth more.`;
  }
  if (prize.reward.kind === "free_shipping") {
    return `${minimum}, where shipping would otherwise be charged.`;
  }
  return `${minimum}. Added on top of any other discount.`;
}
