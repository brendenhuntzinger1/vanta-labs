// ORDER CONTRIBUTION. One formula, one home, never a second inlined copy.
//
// THE QUESTION THIS ANSWERS, and the one it does not.
//
//   "If this order had not happened, how much cash would Vanta have kept?"
//
// That is not the same question as `computeOrderProfit` (order-profit.ts)
// answers, and the two must never be confused or summed together:
//
//   computeOrderProfit   ACCOUNTING TRUTH, cash basis, per order, for the
//                        owner's P&L. Counts commission, refunds, the
//                        customer-paid card surcharge and shipping revenue;
//                        recognises loyalty value ONLY when it is spent.
//
//   this module          MARKETING TRUTH, accrual on the loyalty side, per
//                        order, for deciding whether a campaign paid for
//                        itself. Excludes commission BECAUSE the commission
//                        floor (D7/M7) is bounded BY this number, and accrues
//                        the points liability an order CREATES.
//
// Neither is wrong. They are different metrics with different bases, and §"THE
// ONE THING THAT CANNOT BE SUMMED" below states the consequence in full.
//
// ---------------------------------------------------------------------------
// THE FORMULA (blueprint §C1, locked by decisions B2/B4 and D7)
//
//   contributionBeforeCommission =
//         paidMerchandise            subtotal − discount_amount (M4's base)
//       + shippingCollected
//       + handlingCollected
//       − productCost                COGS of the PAID lines
//       − giftCogs                   COGS of Vanta-funded gift units, AT COST
//       − processingFee              the modelled processor take
//       − shippingCost               postage the store pays
//       − storeCreditRedeemed        non-cash tender: cash never received
//       − pointsRedeemedValue        non-cash tender: cash never received
//       − pointsEarnedValue          liability this order CREATES
//
// INCLUDED, and why each earns its place:
//
//   Paid merchandise        the revenue. `deriveOrderBases().paidMerchandise`,
//                           never re-derived here — see bases.ts.
//   Shipping + handling     customer-paid, so they are revenue like any other.
//   Product COGS            the goods left the building.
//   Gift COGS               a Vanta-funded gift is free to the CUSTOMER, not to
//                           Vanta. Requirement 7: valued at the snapshotted
//                           unit COST, never at retail. Charging retail would
//                           make every gift look ruinous and would double-count
//                           against `giftDisplacedRevenue`, which already
//                           measures the revenue side of the same gift.
//   Processing fee          see processor-cost.ts. Modelled, never settled.
//   Shipping cost           real postage (estimate until the label is bought).
//   Store credit redeemed   contra-revenue. The goods shipped; the cash did not
//                           arrive. Same treatment order-profit.ts gives it.
//   Points redeemed         contra-revenue, identically.
//   Points EARNED           ACCRUAL, and the one deliberate departure from
//                           order-profit.ts's cash basis. An order that mints
//                           5% of its own value in points has created a real
//                           obligation, and the commission floor is bounded by
//                           contribution — so excluding it would let commission
//                           push true contribution negative while this number
//                           reported the order as healthy (decision B4).
//
// EXCLUDED, and why each is kept out:
//
//   Sales tax               pass-through. Never Vanta's money in either
//                           direction. (Production: `count_sales_tax_as_profit`
//                           is false, so the P&L agrees.)
//   Ambassador commission   IT IS WHAT THE FLOOR BOUNDS. Subtracting it here
//                           and then bounding commission by the result is
//                           circular. `applyCommissionFloor` below consumes
//                           this number; it is never an input to it.
//   Membership revenue      a subscription is a separate product with its own
//                           economics. An order must stand on its own, or every
//                           member's order looks profitable on the strength of
//                           a fee they paid for something else. Membership
//                           ORDERS (order_type = 'membership') have no
//                           merchandise, no COGS and never ship: they are not
//                           merchandise orders and carry no contribution
//                           snapshot at all. See `MEMBERSHIP_ORDERS_EXCLUDED`.
//   Refunds                 settled later, and prorated by their own path
//                           (payment-webhook's merchandiseBase). Folding a
//                           refund in here would mean the number changes after
//                           the fact, and a snapshot that moves is not a
//                           snapshot.
//   Customer-paid card fee  `orders.card_processing_fee` is passed TO the
//                           customer, so it is neither Vanta revenue nor a
//                           Vanta cost. (Production: the surcharge is disabled
//                           — enabled:false, percentage:0 — so it is $0 on
//                           every live order to date and this exclusion is a
//                           policy statement rather than a live subtraction.)
//   Fixed overhead          not attributable to an order.
//
// "DISCOUNT IMPACT" IS ALREADY IN, AND IS NOT A SEPARATE LINE. The discount is
// inside `paidMerchandise` by construction — M4's base is
// `max(0, subtotal − discount_amount)`. Subtracting `discountAmount` again
// would double-count it, so it is carried on the breakdown as METADATA
// (`discountAmount`) for display and never as a term of the sum. A test pins
// that: contribution is invariant to `discountAmount` once paidMerchandise is
// fixed.
//
// ---------------------------------------------------------------------------
// THE ONE THING THAT CANNOT BE SUMMED
//
// Points are counted twice across an account's LIFETIME, once at each end:
// accrued as `pointsEarnedValue` on the order that mints them, and again as
// `pointsRedeemedValue` on the later order that spends them. That is correct
// PER ORDER — each order really did create, or really did consume, that value —
// and it is exactly what makes the number usable for "did this campaign pay for
// itself".
//
// It means SUM(contribution) OVER ALL ORDERS IS NOT A P&L. It understates
// lifetime profit by the value of every point that has been both earned and
// spent. Aggregate contribution by campaign, by cohort, by channel — that is
// what it is for. Never present it as, reconcile it to, or add it to the
// figures order-profit.ts produces. The conversion-architecture phase will
// aggregate this number; this paragraph is the constraint it inherits.
//
// ---------------------------------------------------------------------------
// UNITS: THE CENTS BOUNDARY IS HERE, AND ONLY HERE.
//
// M4 kept the three bases in DOLLARS because `orders.subtotal` and
// `orders.discount_amount` are numeric(12,2) and a conversion is a rounding
// boundary a provably-identical refactor cannot afford. Contribution is not a
// refactor of anything — it is a new number — so it takes the opposite and
// better choice: it converts its dollar inputs to INTEGER CENTS exactly once,
// at `toContributionCents` below, sums in integers, and returns integers.
//
// Ten terms summed as floats is where a cent goes missing; ten terms summed as
// integers cannot lose one. `toContributionCents` is the ONLY dollars-to-cents
// conversion in the contribution path, and sot-contribution.test.ts asserts no
// other module performs one — that is what "one explicit boundary" means here.
//
// The name is deliberately unique rather than a tidy `toCents`: an unrelated
// private `toCents` already lives in referral-qualification.ts, and a guard
// that cannot tell the two apart is a guard that either fires on the innocent
// one or stops watching this one.
// ---------------------------------------------------------------------------

/**
 * Bump when the SET OF TERMS or their signs change — never for a bug fix that
 * makes the same formula compute correctly.
 *
 * Persisted beside every snapshot so a later reader can tell a v1 number from a
 * v2 one instead of comparing two definitions silently.
 */
export const CONTRIBUTION_FORMULA_VERSION = 1;

/**
 * Membership subscription orders carry NO contribution snapshot.
 *
 * Stated as an exported constant rather than a comment because it is a rule a
 * caller has to apply — this module is pure and cannot see `order_type`.
 * See the exclusion list above.
 */
export const MEMBERSHIP_ORDERS_EXCLUDED = true;

/**
 * WHEN the number was computed, which decides how much of it is known.
 *
 *   "quote"    at checkout, before the charge settles. COGS may be a
 *              worst-case fallback, postage is the configured estimate, and
 *              the points-earned rate is the member's tier rate with the
 *              promotional multiplier assumed to be 1 (there has never been an
 *              active promotional point event in production — measured
 *              2026-09-12 — so the assumption is exact today and flagged
 *              rather than hidden for the day it is not).
 *   "settled"  after payment, from what the order actually recorded:
 *              `orders.points_earned`, real per-line `unit_cost_cents`, and the
 *              exact label cost once shipped.
 */
export type ContributionBasis = "quote" | "settled";

/** The deduction lines, in the fixed order a tie in `bindingConstraint` breaks. */
export const CONTRIBUTION_DEDUCTION_KEYS = [
  "productCost",
  "giftCogs",
  "processingFee",
  "shippingCost",
  "storeCreditRedeemed",
  "pointsRedeemedValue",
  "pointsEarnedValue",
] as const;

export type ContributionDeductionKey = typeof CONTRIBUTION_DEDUCTION_KEYS[number];

export type ContributionInput = {
  /**
   * `deriveOrderBases(...).paidMerchandise` — NOT `subtotal − discount`
   * restated. bases.ts owns that expression; passing anything else here is the
   * restatement M4 exists to prevent.
   */
  paidMerchandise: number;
  /** Shipping charged to the customer (0 on a free-shipping order). */
  shippingCollected: number;
  /** Handling charged to the customer. Zero on every live order today. */
  handlingCollected?: number;
  /** COGS of the lines the customer PAID for, in dollars. */
  productCost: number;
  /** COGS of Vanta-funded gift units, in dollars, AT COST. Requirement 7. */
  giftCogs?: number;
  /** `processorCostFor(...)` — never a local `× percent / 100`. */
  processingFee: number;
  /** Postage the store pays: the configured estimate, or the exact label cost. */
  shippingCost: number;
  /** Store credit applied, in dollars (`store_credit_redeemed_cents / 100`). */
  storeCreditRedeemed?: number;
  /** Dollar value of points applied (`pointsToDollars(points_redeemed)`). */
  pointsRedeemedValue?: number;
  /** Dollar value of points this order MINTS (`pointsToDollars(points_earned)`). */
  pointsEarnedValue?: number;
  /** See ContributionBasis. Recorded, never used in the arithmetic. */
  basis: ContributionBasis;
  /**
   * The winning customer discount, in dollars. METADATA ONLY — already inside
   * `paidMerchandise`, and deliberately not a term of the sum. See the
   * docblock.
   */
  discountAmount?: number;
  /** True when any COGS line fell back to an assumption rather than a snapshot. */
  costIsEstimated?: boolean;
};

export type ContributionBreakdown = {
  formulaVersion: number;
  basis: ContributionBasis;

  // ---- revenue side, integer cents ----
  paidMerchandiseCents: number;
  shippingCollectedCents: number;
  handlingCollectedCents: number;
  /** The three above, summed. */
  revenueCents: number;

  // ---- deductions, integer cents, each POSITIVE ----
  productCostCents: number;
  giftCogsCents: number;
  processingFeeCents: number;
  shippingCostCents: number;
  storeCreditRedeemedCents: number;
  pointsRedeemedValueCents: number;
  pointsEarnedValueCents: number;
  /** Every deduction above, summed. */
  deductionsCents: number;

  /** revenueCents − deductionsCents. MAY BE NEGATIVE, and that is the signal. */
  contributionBeforeCommissionCents: number;

  /**
   * The single largest deduction, or null when there are none.
   *
   * "Why was this order thin?" answered without re-reading nine numbers. Ties
   * break toward the earlier key in CONTRIBUTION_DEDUCTION_KEYS, so the answer
   * is stable rather than dependent on object key order.
   */
  bindingConstraint: ContributionDeductionKey | null;

  // ---- metadata, never terms of the sum ----
  /** The winning discount, carried for display. Already inside paidMerchandise. */
  discountAmountCents: number;
  costIsEstimated: boolean;
};

/**
 * THE dollars-to-cents boundary. The only one in the contribution path.
 *
 * Clamps at zero and treats non-finite as zero. Every input to this formula is
 * a magnitude — revenue, a cost, a redemption — and a negative one is nonsense
 * that would silently flip a sign inside the sum. Refusing it here means a bad
 * input can make contribution WRONG BY A KNOWN AMOUNT rather than wrong by an
 * unknown sign.
 */
function toContributionCents(value: number | undefined | null): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * Contribution before ambassador commission, every line returned individually.
 *
 * Returns the breakdown rather than a number because the admin has to be able
 * to show WHY an order was thin — and because a caller that only gets a total
 * is a caller that will recompute the lines for itself, which is the second
 * home this module exists to prevent.
 */
export function computeContributionBeforeCommission(input: ContributionInput): ContributionBreakdown {
  const paidMerchandiseCents = toContributionCents(input.paidMerchandise);
  const shippingCollectedCents = toContributionCents(input.shippingCollected);
  const handlingCollectedCents = toContributionCents(input.handlingCollected);
  const revenueCents = paidMerchandiseCents + shippingCollectedCents + handlingCollectedCents;

  const deductions: Record<ContributionDeductionKey, number> = {
    productCost: toContributionCents(input.productCost),
    giftCogs: toContributionCents(input.giftCogs),
    processingFee: toContributionCents(input.processingFee),
    shippingCost: toContributionCents(input.shippingCost),
    storeCreditRedeemed: toContributionCents(input.storeCreditRedeemed),
    pointsRedeemedValue: toContributionCents(input.pointsRedeemedValue),
    pointsEarnedValue: toContributionCents(input.pointsEarnedValue),
  };

  let deductionsCents = 0;
  let bindingConstraint: ContributionDeductionKey | null = null;
  let largest = 0;
  // Iterated in the declared order so a tie is broken deterministically.
  for (const key of CONTRIBUTION_DEDUCTION_KEYS) {
    const amount = deductions[key];
    deductionsCents += amount;
    if (amount > largest) {
      largest = amount;
      bindingConstraint = key;
    }
  }

  return {
    formulaVersion: CONTRIBUTION_FORMULA_VERSION,
    basis: input.basis,

    paidMerchandiseCents,
    shippingCollectedCents,
    handlingCollectedCents,
    revenueCents,

    productCostCents: deductions.productCost,
    giftCogsCents: deductions.giftCogs,
    processingFeeCents: deductions.processingFee,
    shippingCostCents: deductions.shippingCost,
    storeCreditRedeemedCents: deductions.storeCreditRedeemed,
    pointsRedeemedValueCents: deductions.pointsRedeemedValue,
    pointsEarnedValueCents: deductions.pointsEarnedValue,
    deductionsCents,

    contributionBeforeCommissionCents: revenueCents - deductionsCents,

    bindingConstraint,
    discountAmountCents: toContributionCents(input.discountAmount),
    costIsEstimated: input.costIsEstimated === true,
  };
}

// ---------------------------------------------------------------------------
// THE COMMISSION FLOOR (decision D7) — DEFINED HERE, CONSUMED AT M7.
//
// It lives in this file because the SOT guard has to be able to say
// "`commission_capped_amount` is derived in exactly one place", and the only
// place that can bound commission by contribution is the place that owns
// contribution.
//
// NOTHING IN PRODUCTION CALLS IT. M5 is reporting-only: no pricing, no payout.
// commission-floor-unused.test.ts asserts the absence of callers in the same
// way person-key-unused.test.ts does for M3, so the day something calls it is a
// deliberate act with a test of its own.
//
// WHAT IT CAN AND CANNOT DO. It can reduce commission to zero. It CANNOT make a
// negative order positive: the blueprint's $50 row stays at −$11.58 with
// commission already at $0, because a gift absorbing the only paid unit leaves
// no merchandise to earn on. The guard for THAT case is the gift's minimum
// basket value, not this floor, and neither substitutes for the other.
// ---------------------------------------------------------------------------

export type CommissionFloorInput = {
  /** `commissionableBase × percent / 100`, in integer cents. */
  commissionCalculatedCents: number;
  /** `computeContributionBeforeCommission(...).contributionBeforeCommissionCents`. */
  contributionBeforeCommissionCents: number;
  /**
   * The contribution the order must RETAIN after commission, in integer cents.
   * Decision B2: defaults to 0 — break-even — matching
   * DEFAULT_PROFIT_SETTINGS.minProfitDollars. Commission may be reduced only to
   * stop commission ITSELF taking contribution below this line; it is never
   * used to rescue an order that was already below it.
   */
  minRetainedContributionCents?: number;
};

export type CommissionFloorResult = {
  /** What the ambassador is paid. `commission_amount` keeps this meaning. */
  commissionPayableCents: number;
  /** Calculated minus payable. Never re-paid on refund. */
  commissionCappedCents: number;
  capReason: "contribution_floor" | null;
};

export function applyCommissionFloor(input: CommissionFloorInput): CommissionFloorResult {
  const calculated = Math.max(0, Math.round(Number(input.commissionCalculatedCents) || 0));
  const contribution = Math.round(Number(input.contributionBeforeCommissionCents) || 0);
  const minRetained = Math.round(Number(input.minRetainedContributionCents ?? 0) || 0);

  // Negative headroom clamps to zero: an order already below the retained line
  // pays no commission, and the floor does not pretend to have rescued it.
  const headroom = Math.max(0, contribution - minRetained);
  const commissionPayableCents = Math.min(calculated, headroom);
  const commissionCappedCents = calculated - commissionPayableCents;

  return {
    commissionPayableCents,
    commissionCappedCents,
    capReason: commissionCappedCents > 0 ? "contribution_floor" : null,
  };
}
