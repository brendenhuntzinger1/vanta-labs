// Profit engine — the single source of truth for how an order's discounts,
// commission, costs, and fees combine, and the guardrail that never lets an
// order finalize below the store's minimum profit.
//
// This module is PURE (no DB, no `server-only`) so the whole rulebook can be
// exhaustively simulated in tests. The live checkout (payment-service.ts) and
// the admin profit reports feed real values in; the rules live here once.
//
// Vanta Labs discount rules (customer gets ONE discount "bucket", never a
// free-for-all stack — the only intentional stack is bundle + a reduced
// referral):
//   • Member                → membership pricing only (exclusive).
//   • Non-member, bundle+code → bundle discount PLUS a reduced referral % (5%).
//   • Non-member, bundle     → bundle discount.
//   • Non-member, code       → full referral % (10%).
//   • Coupon                 → only combines with the above when the admin
//                              enables coupon stacking; otherwise it competes
//                              as the single best discount on its own.
// Ambassador commission is ALWAYS separate: if a valid code is accepted the
// ambassador earns commission on the final discounted subtotal (before tax),
// regardless of which customer discount applied — unless it's their own order.

import {
  PROCESSING_FEE_DEFAULT_PERCENT,
  WORST_CASE_UNIT_COST_DEFAULT,
} from "@/lib/admin-control-shared";
import { processorCostFor } from "@/lib/benefits/processor-cost";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(subtotal: number, percent: number): number {
  return round(subtotal * (percent / 100));
}

export interface ProfitSettings {
  /** Minimum gross margin an order must keep (percent of revenue). */
  minProfitPercent: number;
  /** Minimum gross profit an order must keep (dollars). Both floors apply. */
  minProfitDollars: number;
  /** Assumed unit cost when a SKU has no stored cost (worst case). */
  worstCaseUnitCost: number;
  /** Payment-processor fee assumption (percent of amount charged). */
  processingFeePercent: number;
}

// Default guard: the order must simply never lose money — profit >= $0 after
// product cost, processing fee, commission, and shipping cost. Raise these in
// the admin (Control Center → Profit Protection) if you want a margin buffer
// beyond break-even.
//
// The two numeric assumptions come from admin-control-shared.ts, the same
// constants DEFAULT_PROFIT_CONFIG (admin-control.ts) is built from. They were
// inlined literals here, and no file imported both, so this test-facing default
// could drift away from the one the live checkout runs on with the suite green.
export const DEFAULT_PROFIT_SETTINGS: ProfitSettings = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: WORST_CASE_UNIT_COST_DEFAULT,
  processingFeePercent: PROCESSING_FEE_DEFAULT_PERCENT,
};

/**
 * A customer discount component.
 *
 * The ordering here once meant "the sequence the profit guard peels these off
 * in". Nothing peels any more — the floor reports and never refuses — so this
 * is simply the set of things that can reduce a customer's price.
 */
export type DiscountComponent = "coupon" | "referral" | "bundle" | "membership";

export interface OrderInputs {
  /** Retail subtotal = sum(unitPrice × qty). */
  subtotal: number;
  /** True cost of goods = sum(unitCost × qty), worst-case substituted upstream. */
  productCost: number;
  /** Bundle discount dollars (0 when not a bundle order). */
  bundleDiscount: number;
  /** A valid, accepted ambassador referral code is on the order. */
  referralAccepted: boolean;
  /** Customer referral discount percent on a NON-bundle order (e.g. 10). */
  referralPercent: number;
  /**
   * @deprecated Inert and NOT read by resolveCustomerDiscount. The "bundle +
   * reduced referral" stack was never implemented; on a bundle order the
   * referral contributes $0. Kept optional only so existing tests that pass a
   * value still compile — it has no effect on any calculation. Removed from
   * admin config and the Control Center UI so it can't be set in production.
   */
  bundleReferralPercent?: number;
  /** The customer holds an active membership discount. */
  isMember: boolean;
  /** Membership discount percent (0 when not a member). */
  membershipPercent: number;
  /** Coupon discount dollars (0 when no valid coupon). */
  couponDiscount: number;
  /**
   * Retail subtotal at FULL (pre-quantity-bundle) unit prices. Only meaningful
   * when quantityBundleSavings > 0; percentage candidates are computed on this
   * base so "20% off" means 20% off list — never 20% on top of bundle pricing.
   * Defaults to `subtotal`.
   */
  fullSubtotal?: number;
  /**
   * Dollars already granted by quantity ("Bundle & Save") tier pricing, baked
   * into `subtotal`. When > 0, every candidate COMPETES with the bundle
   * pricing instead of stacking on it: a candidate is only worth what it
   * saves beyond the bundle (max(0, raw − savings)), so the customer always
   * gets exactly ONE discount — bundle pricing or the better promotion.
   * Pass 0 (default) to keep legacy stack-on-bundle behavior.
   */
  quantityBundleSavings?: number;
  /** Bulk-savings discount dollars (a member perk; competes for best value). */
  bulkSavingsAmount?: number;
  /** Personal ambassador discount dollars (competes for best value). */
  personalDiscountAmount?: number;
  /** The personal ambassador discount percent, for labeling only. */
  personalDiscountPercent?: number;
  /**
   * THE STORE-WIDE switch (`coupons.allow_stacking`): a coupon adds on top of
   * whatever else wins, whatever that is. Deliberately broad — the admin has
   * said "coupons stack", full stop.
   *
   * NOT the place for a promotion's own stackWithCoupon flag; that is
   * `promotionStacksCoupon` below, and conflating the two is a money bug.
   */
  allowCouponStacking: boolean;
  /**
   * THIS PROMOTION says a coupon may be added on top of IT.
   *
   * A narrower licence than the store-wide switch, and it has to stay narrow.
   * It used to be OR-ed into allowCouponStacking by the caller, which was
   * harmless only while a promotion and a referral could never both price an
   * order — a coupon could only ever land on the promotion that permitted it.
   * Once the referral was allowed to beat a promotion, the same OR let a
   * promotion that LOST licence a coupon on top of the REFERRAL: four $40
   * units against a stacking Buy 3 Get 1 (worth $40) with a 40% ambassador
   * code (worth $64) and a $20 coupon paid out $84 — two discounts, authorised
   * by an offer the shopper did not receive.
   *
   * So it is applied only when the bundle is the winning candidate.
   */
  promotionStacksCoupon?: boolean;
  /**
   * What to call the coupon-slot value when it wins. Defaults to "Coupon". The
   * checkout fills that slot with a one-time gift's percentage when it is
   * worth more than any typed code, and a receipt must not call a gift a
   * coupon. Labelling only; the arithmetic is unchanged.
   */
  couponLabel?: string;
  /** Ambassador commission percent (admin-set). */
  commissionPercent: number;
  /** Payment-processor fee assumption (percent of amount charged). */
  processingFeePercent: number;
  /**
   * Whether the processor fee applies to collected sales tax too. Defaults to
   * true (most processors charge on the full transaction). When false, the fee
   * base excludes tax.
   */
  processingFeeIncludesTax?: boolean;
  /** Shipping charged to the customer. */
  shippingCollected: number;
  /** Actual shipping cost to the business. */
  shippingCost: number;
  /** Handling fee charged to the customer (contributes to revenue). */
  handlingCollected: number;
  /** Sales tax rate percent (tax is pass-through; excluded from profit). */
  taxPercent: number;
}

export interface DiscountBreakdown {
  amount: number;
  components: DiscountComponent[];
  /** Human label for the applied discount, e.g. "Bundle + 5% referral". */
  label: string;
}

// Resolves the SINGLE customer discount for an order — the one shared rulebook
// used by both the live checkout and the profit guard:
//   • ONE customer discount applies, whichever gives the best value, among:
//     a Buy-X-Get-Y promotion, the referral discount, membership pricing, bulk
//     savings, the personal ambassador discount, and (when it doesn't stack) a
//     coupon. Every one of them competes on savings; none of them is seeded
//     ahead of the others.
//   • Discounts NEVER stack: the winner is the whole discount. A referral code
//     on top of a promotion adds NO extra %, and a promotion on top of a
//     referral adds none either. The ambassador is still attributed and paid
//     commission whichever one wins; the customer just doesn't double-dip.
//   • A coupon competes as a candidate when stacking is off; when the admin
//     enables stacking it adds on top of the best promo.
// Ambassador commission is NOT a customer discount — it is computed separately
// and is never affected by which discount wins here.
// `enabled` lets the profit guard recompute with the removable promos (coupon,
// referral, bundle) peeled off; membership/bulk/personal are perks and stay.
export function resolveCustomerDiscount(
  inputs: OrderInputs,
  enabled: Set<DiscountComponent>,
): DiscountBreakdown {
  const { subtotal } = inputs;
  const isBundle = enabled.has("bundle") && inputs.bundleDiscount > 0;
  const hasReferral = enabled.has("referral") && inputs.referralAccepted;

  // No-stacking with quantity-bundle pricing: `subtotal` already carries the
  // bundle savings, so a candidate's real value to the customer is only what
  // it saves BEYOND those (max(0, raw − alreadyGranted)). With savings of 0
  // (the default, or stacking enabled by the admin) compete() is a no-op and
  // behavior is exactly the legacy stack-on-bundle math.
  const base = inputs.fullSubtotal ?? subtotal;
  const alreadyGranted = Math.max(0, inputs.quantityBundleSavings ?? 0);
  const compete = (raw: number) => Math.max(0, round(raw - alreadyGranted));

  // The bundle "bucket": the Buy-X-Get-Y free item only. It never stacks with
  // a referral — it COMPETES with one, like every other candidate below.
  let bundleBucket = 0;
  const bundleComponents: DiscountComponent[] = [];
  let bundleLabel = "";
  if (isBundle) {
    bundleBucket += inputs.bundleDiscount;
    bundleComponents.push("bundle");
    bundleLabel = "Bundle";
  }

  // The referral bucket.
  //
  // THIS USED TO READ `!isBundle && hasReferral`, WHICH IS NOT A CONTEST — it
  // is a walkover. Any live promotion zeroed the referral outright, however
  // little the promotion was worth and however much the referral was: four
  // $40 units against Buy 3 Get 1 earns one free unit ($40), while a 40%
  // ambassador's code on the same basket is worth $64. The shopper was charged
  // $24 more than the best offer the store had for them, and the store's own
  // promise — "checkout automatically applies whichever single discount saves
  // you the most" — was false on every promotion order carrying a code.
  //
  // Now it enters the candidate list like everything else and the largest
  // saving wins. Exclusivity is unchanged: bundle and referral still never
  // BOTH apply, because only one candidate is ever chosen.
  //
  // The caller must not record a promotion that lost — quoteOrder drops
  // appliedPromotionId when "bundle" is absent from `components`, so a limited
  // promotion never burns a redemption on an order it did not price.
  const referralBucket = hasReferral ? pct(base, inputs.referralPercent) : 0;

  // Perk candidates that compete for best value (never stack, never removed by
  // the profit guard — they carry no removable component).
  const membershipAmount = enabled.has("membership") && inputs.isMember && inputs.membershipPercent > 0
    ? pct(base, inputs.membershipPercent) : 0;
  const bulkAmount = Math.max(0, inputs.bulkSavingsAmount ?? 0);
  const personalAmount = Math.max(0, inputs.personalDiscountAmount ?? 0);

  const couponEnabled = enabled.has("coupon") && inputs.couponDiscount > 0;
  const couponLabel = inputs.couponLabel ?? "Coupon";
  // Lower-case only for the stock label, so "Bundle + coupon" reads as it always has.
  const couponSuffix = inputs.couponLabel ?? "coupon";

  // The single best discount among every competing candidate, ranked by what
  // each is actually worth beyond any bundle pricing already granted.
  // TWO LICENCES, TWO SHAPES.
  //
  // The store-wide switch is broad: the coupon is added to whatever wins, so it
  // leaves the contest and is applied afterwards. A PROMOTION'S own licence is
  // narrow — "a coupon may ride on THIS promotion" — so the promotion and the
  // coupon become ONE PACKAGE that competes as a single candidate.
  //
  // Gating the narrow licence on "did the promotion win the coupon-less
  // contest" is the obvious fix and it is wrong, because it is circular:
  // whether the promotion wins depends on whether the coupon is riding on it.
  // A $40 promotion permitting a $30 coupon is worth $70 against a $64
  // referral, and the shopper is entitled to the $70 — gating on the bare $40
  // hands them $64 and quietly withholds an offer the store authorised.
  const globalStack = inputs.allowCouponStacking && couponEnabled;
  const promotionPackage = !globalStack
    && (inputs.promotionStacksCoupon ?? false)
    && couponEnabled
    && bundleBucket > 0;

  const candidates: DiscountBreakdown[] = [];
  if (promotionPackage) {
    candidates.push({
      amount: bundleBucket + inputs.couponDiscount,
      components: [...bundleComponents, "coupon"],
      label: `${bundleLabel} + ${couponSuffix}`,
    });
  } else if (bundleBucket > 0) {
    candidates.push({ amount: bundleBucket, components: bundleComponents, label: bundleLabel });
  }
  if (referralBucket > 0) candidates.push({ amount: referralBucket, components: ["referral"], label: `${inputs.referralPercent}% referral` });
  if (membershipAmount > 0) candidates.push({ amount: membershipAmount, components: ["membership"], label: "Membership pricing" });
  if (bulkAmount > 0) candidates.push({ amount: bulkAmount, components: [], label: "Bulk savings" });
  if (personalAmount > 0) candidates.push({ amount: personalAmount, components: [], label: inputs.personalDiscountPercent ? `Ambassador ${inputs.personalDiscountPercent}% off` : "Ambassador discount" });

  let best: DiscountBreakdown = { amount: 0, components: [], label: "None" };
  let bestEffective = 0;
  for (const candidate of candidates) {
    const effective = compete(candidate.amount);
    if (effective > bestEffective) {
      best = candidate;
      bestEffective = effective;
    }
  }

  if (globalStack) {
    return {
      amount: round(Math.min(subtotal, compete(best.amount + inputs.couponDiscount))),
      components: [...best.components, "coupon"],
      label: best.amount > 0 ? `${best.label} + ${couponSuffix}` : couponLabel,
    };
  }

  // The coupon ALSO stands alone, ranked LAST so an exact tie goes to the offer
  // the shopper did not have to type. It competes even when a package above
  // already contains it: those are two arrangements of the same code and only
  // one of them can win.
  if (couponEnabled) {
    const couponEffective = compete(inputs.couponDiscount);
    if (couponEffective > bestEffective) {
      best = { amount: inputs.couponDiscount, components: ["coupon"], label: couponLabel };
      bestEffective = couponEffective;
    }
  }

  return { amount: round(Math.min(subtotal, bestEffective)), components: best.components, label: best.label };
}

export interface ProfitBreakdown {
  discount: DiscountBreakdown;
  discountedSubtotal: number;
  /** Ambassador commission (0 unless a code was accepted). */
  commission: number;
  revenue: number;            // discountedSubtotal + shipping + handling (ex-tax)
  productCost: number;
  processingFee: number;      // on the full amount charged incl. tax
  shippingCost: number;
  grossProfit: number;        // revenue − productCost − processing − commission − shippingCost
  // GUARD-INTERNAL ONLY, NEVER RENDERED. Denominator is discountedSubtotal, NOT
  // revenue, so this is not comparable to any margin a human sees; the 0
  // returned at discountedSubtotal <= 0 is a sentinel both consumers gate on
  // (meetsFloor below, quote-order.ts's floor check). Anything read by a person
  // uses marginPercentOf (order-profit.ts), which answers null at zero revenue
  // because null is the only answer that cannot flatter a loss. If this field is
  // ever surfaced or logged, convert it there and update both comparisons.
  grossMarginPercent: number; // grossProfit / discountedSubtotal
  taxCollected: number;
  amountCharged: number;      // what the customer pays (incl. tax)
}

// Computes the full P&L for a given resolved discount. Commission is on the
// discounted subtotal (before tax); the ambassador is always paid when a code
// was accepted (the caller decides acceptance, e.g. excludes self-orders).
export function computeProfit(inputs: OrderInputs, discount: DiscountBreakdown): ProfitBreakdown {
  const discountedSubtotal = round(Math.max(0, inputs.subtotal - discount.amount));
  const commission = inputs.referralAccepted ? pct(discountedSubtotal, inputs.commissionPercent) : 0;
  const taxCollected = pct(discountedSubtotal, inputs.taxPercent);
  const revenue = round(discountedSubtotal + inputs.shippingCollected + inputs.handlingCollected);
  const amountCharged = round(revenue + taxCollected);
  // THE processor-cost model, called rather than restated. Most processors
  // charge on the full transaction (incl. tax); config can exclude tax from the
  // base, and `processorCostFor` applies that rule once for every consumer —
  // this guard, the admin profit report, and the M5 contribution snapshot.
  //
  // THE BASE IS DELIBERATELY GROSS OF NON-CASH TENDER. `amountCharged` does not
  // subtract store credit or points, so on a redeeming order this overstates
  // the fee. That is the conservative direction for a floor that only ever
  // TELLS the owner, and narrowing it would change when they are told — so it
  // stays, and contribution.ts states its own (net) base for its own reasons.
  const processingFee = processorCostFor({
    cashCollected: amountCharged,
    taxCollected,
    percent: inputs.processingFeePercent,
    includesTax: inputs.processingFeeIncludesTax,
  });
  const grossProfit = round(
    revenue - inputs.productCost - processingFee - commission - inputs.shippingCost,
  );
  // 0, not null, is deliberate — it is the sentinel the floor checks gate on. See the field doc above.
  const grossMarginPercent = discountedSubtotal > 0 ? round((grossProfit / discountedSubtotal) * 100) : 0;

  return {
    discount,
    discountedSubtotal,
    commission,
    revenue,
    productCost: round(inputs.productCost),
    processingFee,
    shippingCost: round(inputs.shippingCost),
    grossProfit,
    grossMarginPercent,
    taxCollected,
    amountCharged,
  };
}
// THE floor predicate. Exported because the live checkout (quote-order.ts) ran
// its own inlined copy of these two comparisons, so "is this order above the
// floor?" had two homes and only one of them was the module documented as the
// guardrail. One rule, one place.
//
// IT NO LONGER DECIDES WHETHER AN ORDER MAY COMPLETE — nothing refuses a sale
// for margin any more. It decides whether the owner is TOLD about one, which is
// the same comparison against the same two admin settings, so it stays here
// rather than being restated in the alerting module (that restatement is what
// this export exists to prevent, and SOT-08 guards).
//
// Takes only the two floors it actually reads, so a caller holding an alerting
// threshold rather than a full ProfitSettings can use the same predicate.
export function meetsFloor(
  p: ProfitBreakdown,
  settings: Pick<ProfitSettings, "minProfitDollars" | "minProfitPercent">,
): boolean {
  if (p.grossProfit < settings.minProfitDollars) return false;
  if (p.discountedSubtotal > 0 && p.grossMarginPercent < settings.minProfitPercent) return false;
  return true;
}
