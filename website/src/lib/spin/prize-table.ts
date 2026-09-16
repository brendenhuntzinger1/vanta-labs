import { BAC_WATER_SLUG } from "@/lib/bac-water";
import type { GiftConfig, OfferReward } from "@/lib/offers/gift-terms";

// ---------------------------------------------------------------------------
// THE SIXTEEN WEDGES, AND THE ONE LIST BOTH THE WHEEL AND THE TILL READ.
//
// No `server-only`: the wheel component renders this table directly in the
// browser, and the spin route mints from the same rows on the server. One list,
// so a wedge cannot advertise a minimum the checkout does not enforce. The
// structural test beside this file is what keeps that true.
//
// WHY EVERY WEDGE WINS. A losing wedge is the obvious way to make the good
// prizes feel rarer, and it is wrong twice over here. Commercially, this mails
// to someone who has already stopped buying — spending the one click you earned
// to tell them "nothing" is a strange way to win them back. Legally, prize +
// chance + consideration is what makes a promotion a lottery; keeping every
// wedge a winner and every prize redeemable only against a real order keeps
// this a discount reveal rather than a sweepstakes, with no official rules, no
// free-entry route and no state prize registration. Do not add a "try again"
// wedge without taking that question to counsel first.
//
// WHY THE PRIZES ARE MOSTLY PRODUCT RATHER THAN PERCENTAGES. At this store's
// real dose costs a gift is by far the cheaper promise: GHK-Cu costs $3.65 and
// shows the customer $39.99, Recon Water costs $1.43 and shows $14.99. A
// percentage costs full margin on whatever the basket happens to be, and on the
// biggest baskets it costs the most. Three percentage wedges are here because
// they are the ones a recipient can spend immediately on whatever they were
// already buying; the other thirteen carry the value.
// ---------------------------------------------------------------------------

export type SpinPrize = {
  /**
   * Stable identifier. Not persisted — the offer row records the REWARD, not
   * the wedge — but it is how the table, the tests and the animation refer to
   * one slice, so it must not be reused for a different prize.
   */
  id: string;
  /**
   * What is printed on the wedge. Sixteen wedges at 390px is 22.5° each, so
   * this is short by necessity; the reveal card carries the full name and the
   * minimum.
   */
  wedgeLabel: string;
  /** The full prize name, for the reveal card and the offer's stored label. */
  label: string;
  reward: OfferReward;
  /**
   * The order this prize requires, in cents.
   *
   * Two rules set it, and the test beside this file enforces the first: a
   * gift's cost must stay under 20% of the minimum it gates, and the default is
   * about twice the gift's retail price — near enough that "spend twice what
   * the free thing is worth" reads as fair without being explained.
   *
   * The top two wedges sit below that default deliberately. The median paid
   * order here is $97.48; a jackpot priced at twice its own retail would ask a
   * typical recipient to nearly triple their basket, and a jackpot nobody can
   * reach is excitement with no redemption behind it.
   */
  minSubtotalCents: number;
};

/**
 * How long a spin is good for. Three days rather than the thirty a win-back
 * gift gets, because the deadline is doing most of the converting here — the
 * wheel is the reason to open, the countdown is the reason to buy today.
 *
 * `customer_offers` measures a life in whole days (GiftConfig.ttlDays), so 72
 * hours is the shortest honest deadline this can advertise.
 */
export const SPIN_TTL_DAYS = 3;

/**
 * The wheel, in wedge order.
 *
 * Deliberately interleaved rather than laddered: the array order IS the drawing
 * order on screen, and sixteen wedges sorted by value reads as a gradient with
 * all the good prizes bunched on one side. Alternating cheap and premium makes
 * the wheel look like a wheel, and puts the jackpot opposite an everyday prize
 * so it is visible wherever the pointer sits.
 */
export const SPIN_PRIZES: readonly SpinPrize[] = [
  {
    id: "recon_water",
    wedgeLabel: "RECON WATER",
    label: "Free Recon Water 10mL",
    // THE SLUG COMES FROM bac-water.ts, IT IS NOT TYPED HERE. quoteOrder
    // resolves a gift with an exact `candidate.slug === offer.product_slug` and
    // has no candidate-list fallback, so a stale literal would not degrade
    // loudly — the gift would simply never apply.
    reward: { kind: "free_product", productSlug: BAC_WATER_SLUG },
    // NOT ZERO, THOUGH IT IS THE CHEAPEST WEDGE ON THE WHEEL.
    //
    // With no minimum the correct play for a recipient is to redeem with
    // nothing else in the basket: the store ships a vial, collects the postage
    // and books the COGS as a loss. OFFER_CATALOG's own win-back entry says the
    // same thing, and campaign-gift.ts carries
    // GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS to stop an operator building one.
    // $35 is the floor the existing catalogue already uses for "the order is
    // real" — about half a vial, and well under the $97.48 median order, so
    // this stays the easy wedge it is meant to be.
    minSubtotalCents: 3_500,
  },
  {
    id: "ghk_cu",
    wedgeLabel: "GHK-Cu",
    label: "Free GHK-Cu 50mg",
    reward: { kind: "free_product", productSlug: "ghk-cu" },
    minSubtotalCents: 7_500,
  },
  {
    id: "percent_15_a",
    wedgeLabel: "15% OFF",
    label: "15% off your order",
    reward: { kind: "percent", percent: 15 },
    minSubtotalCents: 0,
  },
  {
    id: "glp_1",
    wedgeLabel: "GLP-1",
    label: "Free GLP-1 5mg",
    reward: { kind: "free_product", productSlug: "glp-1" },
    minSubtotalCents: 9_900,
  },
  {
    id: "free_shipping",
    wedgeLabel: "FREE SHIP",
    label: "Free shipping",
    // WORTH NOTHING AT OR ABOVE THE FREE-SHIPPING THRESHOLD, which is $200 in
    // the live admin config (admin_audit_logs, set 2026-08-23 — the $250 in
    // PRICING_STRATEGY.md is stale). Left with no minimum on purpose: below
    // $200 it is a real $15, and the median order here is $97.48, so it lands
    // with value far more often than not.
    //
    // THE FLOOR IS FOR THE POSTAGE, NOT THE MARGIN. Waiving shipping on a $10
    // order means eating $7.93 to send it — the same loss the Recon Water wedge
    // is fenced against, arriving by a different route. $35 is the floor the
    // existing catalogue uses, and it leaves plenty of room under the $200
    // ceiling where the waiver stops being worth anything.
    reward: { kind: "free_shipping" },
    minSubtotalCents: 3_500,
  },
  {
    id: "klow",
    wedgeLabel: "KLOW",
    label: "Free KLOW 80mg",
    reward: { kind: "free_product", productSlug: "klow" },
    minSubtotalCents: 20_000,
  },
  {
    id: "percent_20",
    wedgeLabel: "20% OFF",
    label: "20% off your order",
    reward: { kind: "percent", percent: 20 },
    minSubtotalCents: 0,
  },
  {
    id: "semax",
    wedgeLabel: "SEMAX",
    label: "Free Semax 10mg",
    reward: { kind: "free_product", productSlug: "semax" },
    minSubtotalCents: 9_900,
  },
  {
    id: "mt_2",
    wedgeLabel: "MT-2",
    label: "Free MT-2 10mg",
    reward: { kind: "free_product", productSlug: "mt-2-melanotan-ii" },
    minSubtotalCents: 7_500,
  },
  {
    id: "glow",
    wedgeLabel: "GLOW",
    label: "Free GLOW 70mg",
    reward: { kind: "free_product", productSlug: "glow" },
    minSubtotalCents: 17_500,
  },
  {
    id: "percent_15_b",
    wedgeLabel: "15% OFF",
    label: "15% off your order",
    reward: { kind: "percent", percent: 15 },
    minSubtotalCents: 0,
  },
  {
    id: "glp_2",
    wedgeLabel: "GLP-2",
    label: "Free GLP-2 5mg",
    reward: { kind: "free_product", productSlug: "glp-2" },
    minSubtotalCents: 9_900,
  },
  {
    id: "cjc_ipamorelin",
    wedgeLabel: "CJC+IPA",
    label: "Free CJC-1295 + Ipamorelin 10mg",
    reward: { kind: "free_product", productSlug: "cjc-1295-ipamorelin" },
    minSubtotalCents: 12_500,
  },
  {
    id: "tesamorelin",
    wedgeLabel: "TESA",
    label: "Free Tesamorelin 10mg",
    reward: { kind: "free_product", productSlug: "tesamorelin" },
    minSubtotalCents: 15_000,
  },
  {
    id: "glp_3",
    wedgeLabel: "GLP-3",
    label: "Free GLP-3 5mg",
    reward: { kind: "free_product", productSlug: "glp-3" },
    minSubtotalCents: 9_900,
  },
  {
    id: "hgh",
    wedgeLabel: "HGH",
    label: "Free HGH GH-191 24iu",
    reward: { kind: "free_product", productSlug: "hgh-gh-191" },
    minSubtotalCents: 12_500,
  },
];

/** The offer config one wedge mints. Every wedge shares the same short life. */
export function giftConfigForPrize(prize: SpinPrize): GiftConfig {
  return {
    label: prize.label,
    reward: prize.reward,
    minSubtotalCents: prize.minSubtotalCents,
    ttlDays: SPIN_TTL_DAYS,
  };
}

/**
 * Pick a wedge.
 *
 * `randomInt` is injected so the draw is testable, and defaults to the CSPRNG
 * rather than Math.random. That is not ceremony: the outcome is worth up to
 * $119.99 of product, and Math.random is both predictable from prior outputs
 * and biased in ways that are invisible until someone looks for them.
 *
 * THE SERVER DRAWS, AND IT DRAWS BEFORE THE WHEEL MOVES. The client is told
 * which wedge to land on. A browser that picks its own prize can refresh until
 * it likes the answer.
 */
export function drawSpinPrize(randomInt: (boundExclusive: number) => number = cryptoRandomInt): SpinPrize {
  const index = randomInt(SPIN_PRIZES.length);
  const safe = Number.isInteger(index) && index >= 0 && index < SPIN_PRIZES.length ? index : 0;
  return SPIN_PRIZES[safe];
}

/**
 * The wedge a stored offer row came from, or null when the wheel did not mint
 * it.
 *
 * A returning visitor must see the prize they already span for rather than a
 * fresh wheel, and the offer row is the only record of what they won — the
 * wedge id is deliberately not persisted, because the row must keep meaning
 * what it meant even if this table is edited inside the offer's 72 hours.
 *
 * Null matters as much as a match: a customer can hold a live cart-recovery
 * gift that this wheel never produced, and animating to a wedge for it would
 * show them a prize they never won.
 */
export function prizeForOfferRow(row: {
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
}): SpinPrize | null {
  return (
    SPIN_PRIZES.find((prize) => {
      if (prize.reward.kind !== row.reward_kind) return false;
      if (prize.reward.kind === "free_product") return prize.reward.productSlug === row.product_slug;
      if (prize.reward.kind === "percent") return prize.reward.percent === row.percent_off;
      return true;
    }) ?? null
  );
}

function cryptoRandomInt(boundExclusive: number): number {
  // Node's randomInt is rejection-sampled, so it is uniform over the range
  // rather than modulo-biased toward the low wedges.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomInt } = require("node:crypto") as typeof import("node:crypto");
  return randomInt(boundExclusive);
}
