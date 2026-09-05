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
   * The admin's coupon-stacking policy (`coupons.allow_stacking`), OR the
   * active promotion's own `stackWithCoupon` flag — whichever grants it.
   *
   * THE CART DID NOT USED TO KNOW THIS, AND THAT WAS THE LAST PLACE THE CART
   * AND THE CHECKOUT DISAGREED. resolveCustomerDiscount has always had an
   * additive branch for it (`allowCouponStacking && couponEnabled` -> best +
   * coupon); this function had no such branch and no such input, so with
   * stacking ON the server charged best+coupon while the cart previewed
   * max(best, coupon). The shopper was quoted a total higher than the card was
   * charged — not a blocked sale, but a wrong number on the page and a discount
   * the shopper had no way to see they were getting.
   *
   * Defaults to false, which is both the store's current setting and the
   * behaviour every existing caller had.
   */
  allowCouponStacking?: boolean;
  /**
   * The Buy-X-Get-Y free item AND a valid referral — both, when both are live.
   *
   * THIS WAS `promo: DiscountCandidate | null`, "one or the other", because
   * resolveCustomerDiscount zeroed the referral whenever a promotion was
   * present (`!isBundle && hasReferral`). It no longer does: a promotion and a
   * referral are two candidates that compete on savings like everything else,
   * so the cart has to rank both or it would preview a promotion on a basket
   * the server prices with the referral.
   *
   * Order matters on an exact tie. Both sides pick with a strict `>`, so the
   * candidate listed FIRST wins one; resolveCustomerDiscount pushes bundle
   * before referral, so a caller must too.
   */
  promos: DiscountCandidate[];
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

  const stacking = inputs.allowCouponStacking === true && inputs.couponDiscountAmount > 0;

  // Candidates at their RAW value. `compete` is applied when they are ranked,
  // exactly as resolveCustomerDiscount does it — the distinction matters only
  // in the stacking branch below, where the server adds the coupon to the
  // winner's RAW amount and competes the pair once.
  //
  // IN THE SERVER'S ORDER, BECAUSE THE ORDER IS THE TIE-BREAK. Both sides pick
  // with a strict `>`, so on an exact tie the candidate pushed FIRST wins.
  // resolveCustomerDiscount pushes bundle, referral, membership, bulk,
  // personal, coupon. This list used to lead with bulk and membership, so a
  // 10% referral against a 10% member tier — production's default program
  // percent against its Core/Elite tiers — won here as "membership" and on the
  // server as "referral". Same amount, but whether the REFERRAL won decides
  // whether store credit and points may be spent, so the two totals diverged
  // and every such checkout was refused as an altered total.
  const rawCandidates: DiscountCandidate[] = [
    ...inputs.promos.map((promo) => ({ type: promo.type, amount: promo.amount })),
    { type: "member_pricing", amount: inputs.memberPricingAmount },
    { type: "bulk_savings", amount: inputs.bulkSavingsAmount },
    { type: "ambassador_personal", amount: inputs.ambassadorPersonalAmount },
    // With stacking ON the coupon is not a competitor — it is added on top of
    // whatever wins — so it must not also stand in the contest, or it would
    // beat the promotion it is about to be added to and be counted once
    // instead of twice. resolveCustomerDiscount excludes it for exactly this
    // reason (`couponEnabled && !inputs.allowCouponStacking`).
    ...(stacking ? [] : [{ type: "coupon" as const, amount: inputs.couponDiscountAmount }]),
  ];

  // Ranked on what each saves BEYOND the bundle pricing already in `subtotal`,
  // while keeping the raw amount — the server's `best` / `bestEffective` pair.
  let best: DiscountCandidate | null = null;
  let bestEffective = 0;
  for (const candidate of rawCandidates) {
    const effective = compete(candidate.amount);
    if (effective > bestEffective) {
      best = candidate;
      bestEffective = effective;
    }
  }

  if (stacking) {
    // `best?.amount ?? 0` is the server's zero sentinel: when nothing clears
    // the bundle savings on its own, the coupon is added to 0 rather than to a
    // promotion that is worth nothing here. Getting this wrong quoted $15 off a
    // basket the server charged in full.
    const stacked = compete((best?.amount ?? 0) + inputs.couponDiscountAmount);
    return {
      // The coupon is part of the price either way; when it is the only thing
      // reducing the total, it is also the thing to name.
      best: best ?? { type: "coupon", amount: inputs.couponDiscountAmount },
      amount: round(Math.min(inputs.subtotal, stacked)),
    };
  }

  return { best, amount: round(Math.min(inputs.subtotal, bestEffective)) };
}

// ---------------------------------------------------------------------------
// WHAT THE SHOPPER IS TOLD WHEN THEY ENTER A CODE.
//
// "Only one discount per order, greatest savings wins" is correct pricing and
// was terrible copy. A coupon that lost still reported "Coupon applied." next
// to its headline offer, so a shopper on the 12% bundle tier who entered a 10%
// code was told the code was applied to a total it did not move.
//
// The rule: only the discount that actually controls the price may be
// described as applied, and when the code loses, the winner is named. Living
// here rather than in a component means the cart drawer and the checkout page
// cannot drift into two different explanations of the same outcome.
// ---------------------------------------------------------------------------

/** `bundle_pricing` is not a DiscountCandidate — it is baked into the subtotal
 *  before the candidates compete — but it can still be what beat the coupon. */
export type PriceControllingDiscount = DiscountType | "bundle_pricing";

export interface CouponOutcome {
  /** True only when the entered coupon is the discount reducing the total. */
  controlsPrice: boolean;
  /** Customer-facing sentence. Never claims an inactive coupon lowered a price. */
  message: string;
}

/**
 * THE SERVER'S QUOTE OUTRANKS THE CLIENT'S GUESS. The client derives the
 * coupon's fate from the discounts it can model, and it cannot model an armed
 * gift; the quote can. When a quote is present and did NOT record the code,
 * the code was not applied — whatever the client worked out — and the message
 * names what the quote says won instead.
 */
export function couponOutcomeAgainstQuote(input: {
  outcome: CouponOutcome | null;
  couponCode: string | null;
  quote: { couponCode: string | null; discountLabel: string | null } | null;
}): CouponOutcome | null {
  const code = input.couponCode?.trim().toUpperCase() ?? "";
  if (!code) return null;
  if (!input.quote) return input.outcome;
  if ((input.quote.couponCode ?? "").trim().toUpperCase() === code) return input.outcome;
  const winner = input.quote.discountLabel?.trim() ?? "";
  return describeCouponOutcome({
    code,
    offerLabel: null,
    winnerType: null,
    winnerLabel: winner && !/^(none|discount|coupon)$/i.test(winner) ? winner : null,
  });
}

/**
 * The one-line description of an applied code shown under the coupon field —
 * "SAVE10 · 10% off", "SHIPFREE · Free shipping", "VIP · 15% off + Free
 * shipping". Shared by the cart drawer and the checkout page so a
 * free-shipping-only code (discount_value 0) is never printed as "0% off".
 */
export function couponHeadline(
  details: { code: string; discountType: "percent" | "fixed"; discountValue: number; freeShipping?: boolean },
  formatCurrency: (value: number) => string,
): string {
  const parts: string[] = [];
  if (details.discountValue > 0) {
    parts.push(details.discountType === "fixed" ? `${formatCurrency(details.discountValue)} off` : `${details.discountValue}% off`);
  }
  if (details.freeShipping) parts.push("Free shipping");
  return parts.length > 0 ? `${details.code} · ${parts.join(" + ")}` : details.code;
}

export function describeCouponOutcome(input: {
  code: string;
  /** Headline offer, e.g. "10% off". Shown ONLY when the coupon actually wins. */
  offerLabel: string | null;
  winnerType: PriceControllingDiscount | null;
  /** Customer-facing name of the winner, e.g. "Bundle pricing". */
  winnerLabel: string | null;
  /**
   * The code is waiving a shipping fee this order would otherwise pay. Shipping
   * is not part of the discount race (see isShippingWaived in shipping.ts), so
   * a code can lose the percentage contest and still be in the price — and a
   * free-shipping-only code (discount_value 0) never enters the race at all.
   * Either way it changed the total, so it must not be described as doing
   * nothing.
   */
  waivesShipping?: boolean;
}): CouponOutcome {
  const code = input.code.trim();

  if (input.winnerType === "coupon") {
    const offer = input.offerLabel?.trim();
    const parts = [offer, input.waivesShipping ? "Free shipping" : null].filter((part): part is string => Boolean(part));
    return {
      controlsPrice: true,
      message: parts.length > 0 ? `Coupon applied — ${code} · ${parts.join(" + ")}.` : `Coupon applied — ${code}.`,
    };
  }

  if (input.waivesShipping) {
    // The percentage (if any) lost, but the shipping line is $0 because of this
    // code. That is the code controlling part of the price, so it is confirmed
    // — and only the part that is actually in effect is named.
    return {
      controlsPrice: true,
      message: `Coupon applied — ${code} · Free shipping.`,
    };
  }

  const winner = input.winnerLabel?.trim();
  if (winner) {
    // Name the winner. Deliberately omits the coupon's own percentage: quoting
    // an offer that is not in effect is what made the old copy misleading.
    return {
      controlsPrice: false,
      message: `${code} accepted — but your ${winner} saves you more, so we kept that.`,
    };
  }

  return {
    controlsPrice: false,
    message: `${code} accepted — but it doesn't lower the total on this order.`,
  };
}
