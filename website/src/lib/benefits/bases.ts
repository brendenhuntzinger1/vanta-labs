// THE THREE BASES. One derivation, three consumers, no duplicated arithmetic.
//
// WHY THREE. Until now one value — `commissionableSubtotal`, recomputed as
// `max(0, subtotal - discount_amount)` at three separate sites in
// payment-webhook.ts — served four consumers at once:
//
//   ambassador commission            payment-webhook.ts:1179
//   loyalty points earning           payment-webhook.ts:1771, :3126
//   refund proration (merchandiseBase) payment-webhook.ts:2539
//   referral_orders.amount_paid      payment-webhook.ts:1215
//
// That is fine while the four want the same number and fatal the moment they
// do not. They do not: a Vanta-funded gift that ABSORBS units already in the
// basket reduces `subtotal` itself (quote-order.ts:910-947), so the ambassador
// is quietly paid on a smaller base for an incentive they did not provide —
// while points and refunds are correct to use the smaller number, because the
// customer really did pay less.
//
// Raising the single value would fix commission and simultaneously mint points
// on free product and change how every refund is prorated. So the value splits
// into three, each named for the question it answers:
//
//   paidMerchandise     what the customer actually paid for goods.
//                       ACCOUNTING TRUTH. Refund proration and amount_paid.
//                       Byte-identical to today's commissionableSubtotal, now
//                       and always.
//
//   rewardBase          what may earn points and count toward store-credit
//                       eligibility. Paid merchandise only; a free gift never
//                       earns rewards.
//
//   commissionableBase  what the ambassador is paid on. Paid merchandise plus
//                       revenue a Vanta-funded gift displaced.
//
// AT M4 ALL THREE ARE EQUAL. The flags below are all default-off, and with
// them off this function returns the same number three times — the number
// production has always used. That equality is the no-op guarantee, and
// bases.test.ts asserts it across the reachable input space rather than on a
// handful of examples.
//
// UNITS ARE DOLLARS, NOT CENTS, and that is deliberate rather than sloppy.
// `orders.subtotal` and `orders.discount_amount` are numeric(12,2) dollars,
// `roundMoney` is the rounding every money path in this codebase uses, and
// today's `commissionableSubtotal` is dollars. Deriving in cents would mean a
// conversion, and a conversion is a rounding boundary — the one thing a
// provably-identical refactor cannot afford. The blueprint drafted these as
// `...Cents`; matching the surrounding code matters more than matching the
// document, and this comment is the record of that choice.

/** Every money path in this codebase rounds this way. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Consumption flags, all default OFF.
 *
 * Each one is a control-store key at M6/M7/M9 (see the blueprint's §D4
 * rollback boundaries). They live here as plain booleans so this function stays
 * pure and testable, and so "what does the flag actually change" is one diff in
 * one file rather than a behaviour scattered across call sites.
 */
export type BenefitFlags = {
  /** M7 — pay commission on revenue an SMS gift displaced. */
  giftDisplacedCommissionSms?: boolean;
  /** M9 — the same for the existing email win-back gift. Separate release. */
  giftDisplacedCommissionEmail?: boolean;
};

export const NO_FLAGS: BenefitFlags = {};

export type OrderBasesInput = {
  /** `orders.subtotal` — merchandise after bundle pricing, before discounts. */
  subtotal: number;
  /** `orders.discount_amount` — the single winning discount. */
  discountAmount: number;
  /**
   * Revenue a Vanta-funded gift took out of `subtotal`, in dollars.
   *
   * Zero for an ADDED gift ($0 line, subtotal untouched) and zero when there is
   * no gift at all — so a basket with no gift can never produce a non-zero
   * value here, which is what makes requirement 7 structural rather than a rule
   * somebody has to remember.
   */
  giftDisplacedRevenue?: number;
  /** Which lifecycle channel funded the gift. Decides WHICH flag applies. */
  giftChannel?: "sms" | "email" | null;
  flags?: BenefitFlags;
};

export type OrderBases = {
  paidMerchandise: number;
  rewardBase: number;
  commissionableBase: number;
  /** Carried through so a caller can record it without recomputing it. */
  giftDisplacedRevenue: number;
  /** True when a flag actually moved commissionableBase off paidMerchandise. */
  commissionUplifted: boolean;
};

/**
 * Derive all three bases. THE only place any of them is computed.
 *
 * A caller wanting "the commission base" asks for `commissionableBase`; one
 * wanting "what was paid" asks for `paidMerchandise`. Nothing reconstructs
 * `subtotal - discountAmount` for itself — that restatement is exactly what
 * let one value drift into four meanings.
 */
export function deriveOrderBases(input: OrderBasesInput): OrderBases {
  // IDENTICAL TO THE EXPRESSION IT REPLACES, character for character in intent:
  //   roundMoney(Math.max(0, subtotal - discountAmount))
  // Any change here changes refund proration and amount_paid, so it does not
  // change.
  const paidMerchandise = roundMoney(Math.max(0, input.subtotal - input.discountAmount));

  // Points and store-credit eligibility. Paid merchandise only — the gift is
  // either a $0 line (adds nothing) or absorbed units (already gone from
  // subtotal), so a free gift cannot earn rewards by construction rather than
  // by a subtraction somebody could forget.
  const rewardBase = paidMerchandise;

  const displaced = Math.max(0, roundMoney(input.giftDisplacedRevenue ?? 0));
  const flags = input.flags ?? NO_FLAGS;
  const flagForChannel = input.giftChannel === "sms"
    ? flags.giftDisplacedCommissionSms === true
    : input.giftChannel === "email"
      ? flags.giftDisplacedCommissionEmail === true
      : false;

  // GATED ON BOTH the flag and a non-zero displacement. With flags off — which
  // is every environment at M4 — this is `paidMerchandise + 0`, so the three
  // bases are one number.
  const uplift = flagForChannel ? displaced : 0;
  const commissionableBase = roundMoney(paidMerchandise + uplift);

  return {
    paidMerchandise,
    rewardBase,
    commissionableBase,
    giftDisplacedRevenue: displaced,
    commissionUplifted: uplift > 0,
  };
}

/**
 * Revenue a gift took out of the paid lines, from the bookkeeping quoteOrder
 * ALREADY keeps in order to undo a gift below its minimum
 * (quote-order.ts:808-817, used at :1318).
 *
 * Two components, and missing the second is the subtle half:
 *
 *   1. the absorbed units, at the price they carried before absorption;
 *   2. the REPRICING LOSS on the units that survived — absorbing one of three
 *      units drops the remaining two from the 3-unit bundle tier to the
 *      2-unit tier, so the line loses more than one unit's price.
 *
 * A line absorbed to nothing contributes only (1), because it has no surviving
 * units; `line.quantity` is 0 there and the second term vanishes on its own.
 */
export function giftDisplacedRevenueFrom(
  absorbed: ReadonlyArray<{
    line: { quantity: number; product: { price: number } };
    quantity: number;
    unitPrice: number;
  }>,
): number {
  let total = 0;
  for (const taken of absorbed) {
    total += taken.quantity * taken.unitPrice;
    total += taken.line.quantity * (taken.unitPrice - taken.line.product.price);
  }
  return Math.max(0, roundMoney(total));
}
