// THE PROCESSOR COST. One model, every caller, no second copy.
//
// WHY THIS FILE EXISTS. "What does the payment processor take off this order?"
// was answered in two places that did not agree and could not be compared,
// because neither was exported:
//
//   profit-engine.computeProfit   pct(amountCharged, processingFeePercent)
//                                 quote time, live checkout floor guard
//   admin-profit.processingFeeFor base × percent/100, zero for manual methods
//                                 after the fact, admin reports
//
// They shared a rate and a tax rule and differed on two things — whether a
// manual (non-card) settlement is charged at all, and what counts as the base —
// with no way to see that from either site. M5 adds a THIRD consumer (order
// contribution), and three private copies of a money rule is how a rate change
// ends up applied on two screens out of three.
//
// So the rule moves here and the callers call it. The extraction is
// deliberately behaviour-preserving; processor-cost-parity.test.ts proves it
// against the exact expressions it replaced, over a swept input space.
//
// ---------------------------------------------------------------------------
// THIS NUMBER IS A MODEL, AND IT IS NOT KNOWN AT QUOTE TIME.
//
// Nothing in this application ever learns what the processor actually charged.
// Veyra reports no per-transaction fee back to us, no settlement file is
// ingested, and there is no column anywhere that holds a settled fee. Every
// processing fee on every surface — the checkout floor guard, the admin profit
// report, and the contribution snapshot M5 adds — is `percent × base` at a rate
// an admin typed into the Control Center.
//
// That is why `computeOrderProfit` defaults `processingFeeIsEstimate` to TRUE
// and labels the expense line "(estimated)", and why this module exports
// PROCESSOR_COST_IS_ALWAYS_MODELLED rather than letting a caller decide.
// The day a settled fee is ingested, it arrives here — one seam, one change.
//
// Production today (measured 2026-09-12): `profit.processing_fee_percent` is
// blank, so the rate is the PROCESSING_FEE_DEFAULT_PERCENT of 8%, and
// `processing_fee_includes_tax` is FALSE, so the base excludes collected sales
// tax. 8% is roughly 2.7x a real card rate (~2.9% + $0.30) — deliberately
// conservative, and load-bearing on every margin figure the store reports.
// ---------------------------------------------------------------------------

/** Every money path in this codebase rounds this way. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Settlement methods that carry no card-processor fee.
 *
 * Moved verbatim from admin-profit.ts, where it was a private const. The live
 * catalogue only offers card today (`payment_methods.card`), so this is
 * forward-looking rather than load-bearing — but it is a rule, and a rule with
 * one home is the whole point of this module.
 */
export const MANUAL_PAYMENT_HINTS = ["cash", "zelle", "venmo", "paypal", "manual", "wire", "ach", "bank"];

export function isManualPaymentMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").toLowerCase();
  return MANUAL_PAYMENT_HINTS.some((hint) => m.includes(hint));
}

/**
 * TRUE, always, and exported so no caller has to decide.
 *
 * See the module docblock: there is no settled-fee source in this application.
 * A consumer that needs to say whether its fee is an estimate reads this rather
 * than hard-coding `true` and hoping someone updates it later.
 */
export const PROCESSOR_COST_IS_ALWAYS_MODELLED = true;

export type ProcessorCostInput = {
  /**
   * The cash the processor actually runs, in dollars.
   *
   * CALLERS DISAGREE ABOUT THIS ON PURPOSE, and the disagreement is real rather
   * than a bug to be papered over here:
   *
   *   quote-time floor guard  `amountCharged` — merchandise + shipping +
   *                           handling + tax, GROSS of store credit and points.
   *                           Overstates the fee on a redeeming order; the
   *                           guard is conservative by design and changing it
   *                           would move when the owner is alerted.
   *   admin profit report     `orders.amount_paid` — the real charge, net of
   *                           non-cash tender.
   *   contribution (M5)       the quote's final total, net of non-cash tender,
   *                           because contribution already deducts credit and
   *                           points as contra-revenue and the processor never
   *                           touched those dollars.
   *
   * This module owns the RATE, the TAX RULE and the MANUAL-METHOD RULE. The
   * base is the caller's to state, and each one states it above.
   */
  cashCollected: number;
  /** Sales tax inside `cashCollected`, in dollars. Only read when `includesTax` is false. */
  taxCollected?: number;
  /** Settlement method, when known. A manual method is charged nothing. */
  paymentMethod?: string | null;
  /** `profitSettings.processingFeePercent`. */
  percent: number;
  /**
   * `profitSettings.processingFeeIncludesTax`. Defaults TRUE — most processors
   * charge on the full transaction — which is the default both call sites
   * already had. Production has this set to FALSE.
   */
  includesTax?: boolean;
};

/**
 * What the processor is modelled to take, in dollars, rounded to cents.
 *
 * Returns 0 rather than a negative or NaN for every degenerate input: a
 * non-finite or non-positive charge, a manual method, a non-finite rate.
 */
export function processorCostFor(input: ProcessorCostInput): number {
  if (isManualPaymentMethod(input.paymentMethod)) return 0;

  const cash = Number(input.cashCollected);
  if (!Number.isFinite(cash) || cash <= 0) return 0;

  const percent = Number(input.percent);
  if (!Number.isFinite(percent) || percent <= 0) return 0;

  const includesTax = input.includesTax ?? true;
  const tax = Math.max(0, Number(input.taxCollected ?? 0) || 0);
  // Rounded before the multiplication so the base is a whole number of cents
  // whichever way it was assembled — `cash` and `tax` both already are, and
  // their float difference is not.
  const base = includesTax ? round(cash) : Math.max(0, round(cash - tax));

  return round(base * (percent / 100));
}
