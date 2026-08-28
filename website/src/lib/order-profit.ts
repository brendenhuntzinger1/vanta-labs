// -------------------------------------------------------------------------
// Canonical per-order profit math — the SINGLE SOURCE OF TRUTH used by the
// admin order detail page, the dashboard analytics, exports, and reports. No
// surface computes profit a different way.
//
// Profit is computed from what an order ACTUALLY recorded — never from today's
// live product cost. The unit cost is the value snapshotted onto each order
// line at checkout (order_items.unit_cost_cents), so a later cost change never
// rewrites a historical order's profit.
//
// True net profit =
//     net merchandise revenue (subtotal − discounts, ex-tax)
//   + shipping revenue collected (what the customer paid for shipping; 0 when
//     the order shipped free)
//   − refunds issued (reverses revenue)
//   − COGS (snapshotted unit cost × qty; the store's all-in cost per item:
//     product + fulfillment + packaging)
//   − payment-processor fee
//   − shipping cost the store actually pays to ship the order (an ESTIMATE
//     until the order ships, then the exact label cost)
//   − ambassador commission
//   − any additional expense line items (ads, chargebacks, … — see
//     extraExpenses; this is how the engine grows without a rewrite)
//
// Sales tax is intentionally NOT counted as profit: tax collected is remitted
// to the state, so it's a pass-through, not earnings. It's carried through only
// so reports can display "Sales tax collected".
//
// STORE CREDIT AND LOYALTY POINTS ARE NON-CASH TENDER, AND THEY ARE CONTRA-
// REVENUE. Both are granted by the store (a monthly membership perk, and points
// earned on earlier orders); neither is money a customer ever paid in. When a
// buyer settles part of an order with either, the merchandise still leaves the
// building at list price but that portion of the invoice is never collected, so
// `creditRedeemed` is deducted from gross revenue. The property that keeps the
// whole engine honest is then true on EVERY order, redemption or not:
//
//     grossRevenue == orders.amount_paid          (when tax counts as profit)
//     grossRevenue == orders.amount_paid - tax    (when tax is pass-through)
//
// which is the same cash definition ledger.netOrderRevenue uses, so the profit
// report and the revenue/analytics pages describe the same dollars.
//
// THE REJECTED ALTERNATIVE: booking the redemption as a marketing EXPENSE line
// instead. It produces the IDENTICAL net profit, because an expense and a
// contra-revenue of the same size subtract equally — but it leaves revenue
// stating money the store never received, and revenue is not only a display
// number: gross margin %, net margin % and average order value are all computed
// against it. A member spending a $75 credit on a $117 order would report an
// AOV of $117 against $42 of cash. Contra-revenue is the treatment that makes
// every figure downstream reconcile, so it is the one implemented.
//
// EARNING points accrues NOTHING here, deliberately. Recognising the cost when
// the credit is spent, and only then, is what stops the same dollar being
// counted twice — once as an accrued liability at earn time and again as a
// deduction at redemption. Cash basis, applied consistently at both ends.
// -------------------------------------------------------------------------

export interface OrderProfitLine {
  /** Cost per unit at checkout time, in cents (order_items.unit_cost_cents). */
  unitCostCents: number | null;
  quantity: number;
}

// Every deduction is its own line item so new expense types (affiliate/
// ambassador commissions, ad spend, chargebacks, refund processing fees,
// warehouse costs, …) can be added later by pushing another entry — no formula
// change, no schema change to this engine.
export type OrderExpenseKind =
  | "cogs"
  | "shipping"
  | "processing"
  | "commission"
  | "other";

export interface OrderExpenseLine {
  /** Stable machine key, e.g. "cogs", "processing_fee". */
  key: string;
  /** Human label for the breakdown UI. */
  label: string;
  /** Dollars, always ≥ 0 (a deduction). */
  amount: number;
  kind: OrderExpenseKind;
}

export interface OrderProfitInput {
  /** Merchandise subtotal collected, ex-tax, ex-shipping, after discounts. */
  netMerchandiseRevenue: number;
  /** Shipping the customer paid (0 for free-shipping orders). */
  shippingRevenue: number;
  /**
   * Other customer-paid revenue beyond merchandise + shipping — e.g. the
   * shipping-protection add-on and any card surcharge. Counted as revenue.
   */
  additionalRevenue?: number;
  /** Shipping cost the store pays to ship this order (estimate or exact). */
  shippingCost: number;
  /** True while shippingCost is still the pre-ship estimate (not the exact label cost). */
  shippingCostIsEstimate?: boolean;
  /** Sales tax collected. Display-only unless countTaxAsProfit is true. */
  taxCollected?: number;
  /**
   * When true, collected sales tax counts toward profit (owner keeps it). When
   * false (default), tax is a pass-through remitted to the state and excluded.
   */
  countTaxAsProfit?: boolean;
  /** COGS lines (snapshotted unit cost × qty). */
  lines: OrderProfitLine[];
  /**
   * Non-cash tender applied to this order, in dollars: store credit redeemed
   * plus the dollar value of loyalty points redeemed.
   *
   * CONTRA-REVENUE, NOT AN EXPENSE — see the module docblock. Deducted from
   * gross revenue so what is reported is what was actually collected.
   *
   * NOT clamped to the order total on purpose: store credit may be applied
   * against collected sales tax as well as merchandise, so on a pass-through
   * tax configuration a large redemption can legitimately push revenue below
   * zero — the store really did remit that tax out of its own pocket.
   */
  creditRedeemed?: number;
  /** Ambassador commission paid on this order (0 if none). */
  commission: number;
  /** Card processing fee the store paid (0 for fee-free / manual methods). */
  processingFee: number;
  /**
   * True while `processingFee` is a CONFIGURED PERCENTAGE rather than the fee
   * the processor actually charged.
   *
   * Defaults to TRUE, and that default is the point. No payment provider in
   * this application reports a per-transaction fee back to us today, so every
   * processing fee on every surface is a modelled number. A caller that forgets
   * to say so therefore under-claims precision instead of over-claiming it —
   * the same direction the COA rail defaults to.
   *
   * Set it false only when a REAL settled fee has been ingested for this order.
   */
  processingFeeIsEstimate?: boolean;
  /** Amount refunded to the customer (reverses revenue). */
  refund: number;
  /**
   * The TAX portion of `refund`, in dollars. Only meaningful when
   * `countTaxAsProfit` is false.
   *
   * A refund returns the sale AND the tax charged on it, so `refund` contains
   * both. When collected tax is treated as a pass-through it was never added to
   * revenue — so deducting the whole refund from revenue removes tax that was
   * never there, and the order reports NEGATIVE revenue equal to its own tax.
   * Supplying this lets the reversal match what was actually counted.
   *
   * Defaults to 0, which is exactly right when tax counts as profit (the
   * reversal is then symmetric with the addition and this term is unused).
   */
  refundedTax?: number;
  /** Worst-case unit cost (cents) used only when a line has no snapshot. */
  fallbackUnitCostCents?: number;
  /**
   * Additional expense line items. The extensibility seam: future costs plug
   * in here (or are appended by the caller) with no change to this engine.
   */
  extraExpenses?: Array<{ key: string; label: string; amount: number; kind?: OrderExpenseKind }>;
}

/**
 * Profit is "estimated" until the exact shipping-label cost AND every line's
 * COGS are known; then it's "finalized".
 *
 * DELIBERATELY NOT gated on the processing fee. That fee is always modelled
 * (nothing reports a settled fee back to us), so including it here would mean
 * no order could ever finalize and the distinction would carry no information.
 * "Finalized" therefore means "shipping and COGS are exact" — the two costs
 * that actually move once an order ships. The processing fee's own precision is
 * reported separately by `processingFeeIsEstimate`, and its expense line says
 * so on its face.
 */
export type ProfitStatus = "estimated" | "finalized";

export interface OrderProfitResult {
  /** Net revenue kept = merchandise + shipping − refund. */
  revenue: number;
  /** Gross revenue before refunds = merchandise + shipping (ex-tax). */
  grossRevenue: number;
  merchandiseRevenue: number;
  shippingRevenue: number;
  /** Alias of shippingRevenue — what the customer was charged for shipping. */
  shippingCharged: number;
  /** Other customer-paid revenue counted in (shipping protection, fees). */
  additionalRevenue: number;
  /**
   * Store credit + points redeemed, in dollars, already deducted from
   * grossRevenue. Surfaced so a breakdown can show the deduction rather than
   * leaving the revenue lines failing to add up to the total.
   */
  creditRedeemed: number;
  /** True when collected sales tax was counted toward profit. */
  taxCountedAsProfit: boolean;
  cogs: number;
  commission: number;
  processingFee: number;
  /** True when the processing fee is modelled from a rate, not a settled fee. */
  processingFeeIsEstimate: boolean;
  shippingCost: number;
  shippingCostIsEstimate: boolean;
  /** Shipping charged − shipping cost (positive = shipping profit). */
  shippingProfit: number;
  /** Sales tax collected (pass-through, shown but not profit). */
  taxCollected: number;
  refund: number;
  /**
   * The portion of `refund` actually reversed out of revenue. Equal to `refund`
   * when collected tax counts as profit; otherwise `refund` minus the tax
   * returned, because that tax was never inside grossRevenue to take back out.
   * Surfaced so a breakdown can show the figure the total was computed from —
   * rendering the whole `refund` beside `profit` makes the visible lines fail
   * to add up whenever tax is a pass-through.
   */
  revenueRefund: number;
  /** Every deduction, in a stable display order. */
  expenses: OrderExpenseLine[];
  /** Sum of all expense line items (excludes the refund revenue reversal). */
  totalExpenses: number;
  profit: number;
  /**
   * Net margin as a percent of revenue, or `null` when there is no revenue to
   * take a proportion of. See marginPercentOf — `null` renders as "n/a", and
   * NEVER as 0%.
   */
  marginPercent: number | null;
  /** True when any line was missing a cost snapshot (COGS is estimated). */
  hasEstimatedCost: boolean;
  /** "finalized" once shipping cost is exact AND every line cost is known. */
  profitStatus: ProfitStatus;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Margin as a percent of revenue — or `null` when the question has no answer.
 *
 * THE ONE DEFINITION, so every surface that renders a margin renders the same
 * convention. A margin is a proportion OF revenue; below or at zero revenue
 * there is nothing to take a proportion of, and BOTH numeric answers available
 * at that boundary are lies in the store's favour:
 *
 *   revenue -50, profit -80  ->  "0%"     reads as broke even (the old answer)
 *   revenue -50, profit -80  ->  "+160%"  two negatives divided (the naive fix)
 *
 * `null` is the only answer that cannot flatter a loss. Callers render it as
 * "n/a" and the dollar profit beside it — which is the real number — carries the
 * bad news on its own. Held by margin-never-flatters-a-loss.test.ts.
 */
export function marginPercentOf(profit: number, revenue: number): number | null {
  if (!Number.isFinite(revenue) || !Number.isFinite(profit) || revenue <= 0) return null;
  return round((profit / revenue) * 100);
}

export function computeOrderProfit(input: OrderProfitInput): OrderProfitResult {
  const fallback = Math.max(0, input.fallbackUnitCostCents ?? 0);
  let cogsCents = 0;
  let hasEstimatedCost = false;

  for (const line of input.lines) {
    const qty = Math.max(0, Math.round(line.quantity));
    if (line.unitCostCents == null) {
      hasEstimatedCost = true;
      cogsCents += fallback * qty;
    } else {
      cogsCents += Math.max(0, Math.round(line.unitCostCents)) * qty;
    }
  }

  const cogs = round(cogsCents / 100);
  const merchandiseRevenue = round(Math.max(0, input.netMerchandiseRevenue));
  const shippingRevenue = round(Math.max(0, input.shippingRevenue));
  const commission = round(Math.max(0, input.commission));
  const processingFee = round(Math.max(0, input.processingFee));
  const shippingCost = round(Math.max(0, input.shippingCost));
  const refund = round(Math.max(0, input.refund));
  const taxCollected = round(Math.max(0, input.taxCollected ?? 0));
  const additionalRevenue = round(Math.max(0, input.additionalRevenue ?? 0));
  const creditRedeemed = round(Math.max(0, input.creditRedeemed ?? 0));
  const countTaxAsProfit = input.countTaxAsProfit ?? false;
  const shippingCostIsEstimate = input.shippingCostIsEstimate ?? false;
  // Defaults TRUE — see the field comment. Nothing ingests a settled fee yet.
  const processingFeeIsEstimate = input.processingFeeIsEstimate ?? true;

  // Ordered expense line items — the extensible ledger of deductions.
  const expenses: OrderExpenseLine[] = [];
  if (cogs > 0) expenses.push({ key: "cogs", label: "Product cost (COGS)", amount: cogs, kind: "cogs" });
  if (shippingCost > 0) {
    expenses.push({
      key: "shipping_cost",
      label: shippingCostIsEstimate ? "Shipping cost (estimated)" : "Shipping cost",
      amount: shippingCost,
      kind: "shipping",
    });
  }
  if (processingFee > 0) {
    // Labelled exactly as the shipping line is. An estimate presented as an
    // actual cost is the one thing a profit figure must never do, and this line
    // is ALWAYS an estimate today.
    expenses.push({
      key: "processing_fee",
      label: processingFeeIsEstimate ? "Payment processor fee (estimated)" : "Payment processor fee",
      amount: processingFee,
      kind: "processing",
    });
  }
  if (commission > 0) expenses.push({ key: "commission", label: "Ambassador commission", amount: commission, kind: "commission" });
  for (const extra of input.extraExpenses ?? []) {
    const amount = round(Math.max(0, Number(extra.amount) || 0));
    if (amount > 0) {
      expenses.push({ key: extra.key, label: extra.label, amount, kind: extra.kind ?? "other" });
    }
  }

  const totalExpenses = round(expenses.reduce((sum, line) => sum + line.amount, 0));
  // Gross revenue = merchandise + shipping charged + other customer-paid fees
  // (shipping protection, surcharge). Collected sales tax is added only when the
  // owner opts to count it (otherwise it's a pass-through, remitted to the state).
  // Store credit and points come off here, as contra-revenue: the merchandise
  // was invoiced at list price, and that slice of the invoice was settled with
  // tender the store issued rather than money the customer paid.
  const grossRevenue = round(
    merchandiseRevenue + shippingRevenue + additionalRevenue + (countTaxAsProfit ? taxCollected : 0) - creditRedeemed,
  );
  // THE REVERSAL MUST MATCH WHAT WAS COUNTED. `refund` is everything handed
  // back, tax included. When tax counts as profit it is inside grossRevenue and
  // the two cancel exactly — a fully refunded order nets to zero. When tax is a
  // pass-through it is NOT inside grossRevenue, so subtracting the whole refund
  // takes out tax that was never added: a fully refunded $127 order (of which
  // $8 was tax) reported revenue of −$8 and profit $8 worse than the truth,
  // once per refunded order, on a toggle the owner is invited to set.
  const refundedTax = round(Math.min(taxCollected, Math.max(0, input.refundedTax ?? 0)));
  const revenueRefund = countTaxAsProfit ? refund : round(Math.max(0, refund - refundedTax));
  const revenue = round(grossRevenue - revenueRefund);
  const profit = round(revenue - totalExpenses);
  const marginPercent = marginPercentOf(profit, revenue);
  const shippingProfit = round(shippingRevenue - shippingCost);
  const profitStatus: ProfitStatus = !shippingCostIsEstimate && !hasEstimatedCost ? "finalized" : "estimated";

  return {
    revenue,
    grossRevenue,
    merchandiseRevenue,
    shippingRevenue,
    shippingCharged: shippingRevenue,
    additionalRevenue,
    creditRedeemed,
    taxCountedAsProfit: countTaxAsProfit,
    cogs,
    commission,
    processingFee,
    processingFeeIsEstimate,
    shippingCost,
    shippingCostIsEstimate,
    shippingProfit,
    taxCollected,
    refund,
    revenueRefund,
    expenses,
    totalExpenses,
    profit,
    marginPercent,
    hasEstimatedCost,
    profitStatus,
  };
}
