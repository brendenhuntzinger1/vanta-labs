import { offerContribution } from "@/lib/cart-recovery-tiers";
import { OFFER_CATALOG, type OfferKey } from "@/lib/offers/customer-offers";

/**
 * WOULD THIS OFFER, ON THIS CART, LEAVE THE STORE ANYTHING?
 *
 * THE HOLE IT WATCHES. The banded ladder sizes a gift against cart value and is
 * defensible by construction — a $500 cart can carry the three-product band. An
 * OVERRIDE has no such arithmetic anywhere: a row in
 * cart_recovery_stage_overrides names an offer_key for one cart, written by
 * hand, and the admin resend button attaches whatever that row says. So the
 * most expensive gift in the catalogue can be attached to the cheapest cart in
 * the store, and nothing between the operator and the send has any opinion
 * about it.
 *
 * Worked at today's live figures (COGS 17.57% of revenue, postage $7.79,
 * processor 8% estimated): a $40 cart contributes about $22 before any
 * incentive. The top band's gifts cost about $31 at COGS. That order ships at a
 * loss of roughly $9, and every screen in the admin reports it as a recovered
 * cart.
 *
 * REPORT-ONLY, DELIBERATELY, AND FOR NOW. `RECOVERY_FLOOR_ENFORCED` is false:
 * this computes, names and alerts, and nothing is refused. An operator override
 * exists precisely because a human has a reason the rules do not know — a
 * customer owed something, a complaint being made right — and turning a new
 * floor straight into a refusal would break that on its first day, in the
 * hands of the one person who cannot ask anyone else to unblock it. Watch what
 * it reports against real sends first; enforcing is a one-line change and the
 * test for the enforced direction is already written.
 *
 * IT MODELS, IT DOES NOT SETTLE. Every figure is estimated — the processor fee
 * most of all, because Vanta does not reconcile per-transaction cost here — and
 * the sum is the same `offerContribution` the band editor renders, so a guard
 * and a screen cannot come to disagree about whether an offer is affordable.
 */

/**
 * The line an offer must leave the order above.
 *
 * ZERO, not a margin target, and the difference matters. This is not "is this
 * offer a good deal"; a recovery offer that merely thins the margin can still
 * be the right call, and that judgement belongs to the operator. It is "does
 * this order, if the gift is redeemed, still leave the business anything at
 * all" — the one question where the answer is not a matter of taste.
 */
export const RECOVERY_OFFER_FLOOR_CENTS = 0;

/** Flip to true only after the reports above have been watched against real sends. */
export const RECOVERY_FLOOR_ENFORCED = false;

export interface RecoveryOfferEconomicsInputs {
  productCostRatio: number;
  postageCents: number;
  /** Estimated, never settled. See the header. */
  processorFeePercent?: number;
  /** Gift COGS by product slug, in cents. A slug that is absent costs nothing here. */
  giftCostCents: Readonly<Record<string, number>>;
}

export interface RecoveryOfferVerdict {
  offerKey: OfferKey;
  cartValueCents: number;
  /** What the order would have left with NO offer attached. The counterfactual. */
  contributionBeforeCents: number;
  /** What it leaves if the gift is redeemed. */
  contributionAfterCents: number;
  /** Gift COGS plus the percentage, at this cart value. */
  incentiveCents: number;
  giftCostCents: number;
  /**
   * FALSE WHEN THE OFFER NAMES A PRODUCT THIS COULD NOT PRICE.
   *
   * The gift is then counted as free, which makes the verdict optimistic — so
   * it must never read as a clean pass. A dose row with no product_cost_cents
   * is the usual cause, and so is a slug that has been renamed underneath the
   * offer catalogue: Recon Water has four resolvable slugs and only one of them
   * is what the products table stores. listGiftableProducts deliberately
   * returns null rather than guessing a cost; this carries that gap forward
   * rather than absorbing it.
   */
  giftCostKnown: boolean;
  percentCostCents: number;
  floorCents: number;
  belowFloor: boolean;
  /** True only when a below-floor verdict would actually stop the send. */
  enforced: boolean;
  /** One line, for an alert or an admin warning. Always says "estimated". */
  summary: string;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Judge one offer against one cart.
 *
 * PURE, so the rule can be asserted without a database, and so the send paths
 * can compute it from figures they already hold rather than taking a second
 * round trip on a path a customer is waiting on.
 *
 * FREE SHIPPING COSTS NOTHING HERE, and that is a statement about this store
 * rather than about shipping. Vanta has shipped everything free since
 * 2026-09-06, so a free-shipping gift waives a charge the customer was never
 * going to pay; the postage itself is already subtracted as a cost on every
 * order, gift or no gift. If the store ever charges for shipping again, the
 * waived revenue belongs in this sum and this comment is where to start.
 */
export function evaluateRecoveryOffer(input: {
  offerKey: OfferKey;
  cartValueCents: number;
  inputs: RecoveryOfferEconomicsInputs;
}): RecoveryOfferVerdict {
  const config = OFFER_CATALOG[input.offerKey];
  const reward = config?.reward as { kind?: string; productSlug?: string; percent?: number } | undefined;

  const giftSlug = typeof reward?.productSlug === "string" ? reward.productSlug : null;
  const knownCost = giftSlug ? input.inputs.giftCostCents[giftSlug] : undefined;
  const giftCostKnown = !giftSlug || (typeof knownCost === "number" && Number.isFinite(knownCost));
  const giftCostCents = Math.max(0, Number(knownCost ?? 0));
  const percentOff = Math.max(0, Number(reward?.percent ?? 0));

  const sums = offerContribution({
    cartValueCents: input.cartValueCents,
    giftCostCents,
    percentOff,
    productCostRatio: input.inputs.productCostRatio,
    postageCents: input.inputs.postageCents,
    processorFeePercent: input.inputs.processorFeePercent,
  });

  const belowFloor = sums.netCents < RECOVERY_OFFER_FLOOR_CENTS;
  const incentiveCents = giftCostCents + sums.percentCostCents;

  return {
    offerKey: input.offerKey,
    cartValueCents: sums.revenueCents,
    contributionBeforeCents: sums.contributionCents,
    contributionAfterCents: sums.netCents,
    incentiveCents,
    giftCostCents,
    percentCostCents: sums.percentCostCents,
    giftCostKnown,
    floorCents: RECOVERY_OFFER_FLOOR_CENTS,
    belowFloor,
    enforced: belowFloor && RECOVERY_FLOOR_ENFORCED,
    summary:
      `${config?.label ?? input.offerKey} on a ${dollars(sums.revenueCents)} cart: `
      + `estimated contribution ${dollars(sums.contributionCents)} before the offer, `
      + `${dollars(sums.netCents)} after an incentive costing ${dollars(incentiveCents)}. `
      + (belowFloor
        ? `That is below the ${dollars(RECOVERY_OFFER_FLOOR_CENTS)} floor — the order would ship at a loss. `
          + (RECOVERY_FLOOR_ENFORCED ? "Refused." : "Reported only; the send was not stopped.")
        : "Above the floor.")
      + (giftCostKnown
        ? ""
        : ` The cost of "${giftSlug}" is not recorded, so the gift counts as free here —`
          + " this verdict is optimistic and cannot be read as a clean pass.")
      + " All figures estimated, including the processor fee.",
  };
}
