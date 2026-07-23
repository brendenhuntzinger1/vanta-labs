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
export const DEFAULT_PROFIT_SETTINGS: ProfitSettings = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: 10,
};

/** A customer discount component, in the order promotions are peeled off when
 * an order is unprofitable (lowest priority first). Membership is a PAID
 * benefit and is never stripped for margin. */
export type DiscountComponent = "coupon" | "referral" | "bundle" | "membership";

// Lowest-priority-first: the profit guard removes coupon, then the referral
// customer discount, then the bundle discount. Membership is never removed.
const REMOVAL_ORDER: DiscountComponent[] = ["coupon", "referral", "bundle"];

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
  /** Reduced referral discount percent on a BUNDLE order (e.g. 5). */
  bundleReferralPercent: number;
  /** The customer holds an active membership discount. */
  isMember: boolean;
  /** Membership discount percent (0 when not a member). */
  membershipPercent: number;
  /** Coupon discount dollars (0 when no valid coupon). */
  couponDiscount: number;
  /** Bulk-savings discount dollars (a member perk; competes for best value). */
  bulkSavingsAmount?: number;
  /** Personal ambassador discount dollars (competes for best value). */
  personalDiscountAmount?: number;
  /** Admin: may a coupon combine with a referral/bundle? */
  allowCouponStacking: boolean;
  /** Ambassador commission percent (admin-set). */
  commissionPercent: number;
  /** Payment-processor fee assumption (percent of amount charged). */
  processingFeePercent: number;
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
//     the referral discount, membership pricing, bulk savings, the personal
//     ambassador discount, and (when it doesn't stack) a coupon.
//   • The ONE intentional stack: a BUNDLE (Buy 3 Get 1) order with a code gets
//     the bundle discount PLUS a reduced referral % (default 5%).
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

  // The bundle "bucket": bundle discount, plus a reduced referral % when a code
  // is also on the order (the one intentional stack).
  let bundleBucket = 0;
  const bundleComponents: DiscountComponent[] = [];
  let bundleLabel = "";
  if (isBundle) {
    bundleBucket += inputs.bundleDiscount;
    bundleComponents.push("bundle");
    bundleLabel = "Bundle";
    if (hasReferral) {
      bundleBucket += pct(subtotal, inputs.bundleReferralPercent);
      bundleComponents.push("referral");
      bundleLabel = `Bundle + ${inputs.bundleReferralPercent}% referral`;
    }
  }

  // The plain referral bucket (non-bundle order with a code).
  const referralBucket = !isBundle && hasReferral ? pct(subtotal, inputs.referralPercent) : 0;

  // Perk candidates that compete for best value (never stack, never removed by
  // the profit guard — they carry no removable component).
  const membershipAmount = enabled.has("membership") && inputs.isMember && inputs.membershipPercent > 0
    ? pct(subtotal, inputs.membershipPercent) : 0;
  const bulkAmount = Math.max(0, inputs.bulkSavingsAmount ?? 0);
  const personalAmount = Math.max(0, inputs.personalDiscountAmount ?? 0);

  const couponEnabled = enabled.has("coupon") && inputs.couponDiscount > 0;

  // The single best discount among every competing candidate.
  const candidates: DiscountBreakdown[] = [];
  if (bundleBucket > 0) candidates.push({ amount: bundleBucket, components: bundleComponents, label: bundleLabel });
  if (referralBucket > 0) candidates.push({ amount: referralBucket, components: ["referral"], label: `${inputs.referralPercent}% referral` });
  if (membershipAmount > 0) candidates.push({ amount: membershipAmount, components: ["membership"], label: "Membership pricing" });
  if (bulkAmount > 0) candidates.push({ amount: bulkAmount, components: [], label: "Bulk savings" });
  if (personalAmount > 0) candidates.push({ amount: personalAmount, components: [], label: "Ambassador personal" });
  if (couponEnabled && !inputs.allowCouponStacking) candidates.push({ amount: inputs.couponDiscount, components: ["coupon"], label: "Coupon" });

  let best: DiscountBreakdown = { amount: 0, components: [], label: "None" };
  for (const candidate of candidates) {
    if (candidate.amount > best.amount) best = candidate;
  }

  // When stacking is enabled, a coupon adds on top of the best promo.
  if (inputs.allowCouponStacking && couponEnabled) {
    return {
      amount: round(Math.min(subtotal, best.amount + inputs.couponDiscount)),
      components: [...best.components, "coupon"],
      label: best.amount > 0 ? `${best.label} + coupon` : "Coupon",
    };
  }

  return { amount: round(Math.min(subtotal, best.amount)), components: best.components, label: best.label };
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
  const processingFee = pct(amountCharged, inputs.processingFeePercent);
  const grossProfit = round(
    revenue - inputs.productCost - processingFee - commission - inputs.shippingCost,
  );
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

export interface ProtectedOrder extends ProfitBreakdown {
  /** True when the order meets the profit floor and may finalize. */
  profitable: boolean;
  /** Discount components removed by the profit guard to restore margin. */
  removed: DiscountComponent[];
  /** Set when the order is blocked even with all promos removed. */
  blockedReason: string | null;
}

function meetsFloor(p: ProfitBreakdown, settings: ProfitSettings): boolean {
  if (p.grossProfit < settings.minProfitDollars) return false;
  if (p.discountedSubtotal > 0 && p.grossMarginPercent < settings.minProfitPercent) return false;
  return true;
}

// The guardrail. Computes the order, and if it's below the floor, peels off the
// lowest-priority customer discount and recomputes, repeating until it's
// profitable or no removable promo remains. If it still can't meet the floor
// (base pricing/commission alone lose money), the order is blocked.
export function protectProfit(inputs: OrderInputs, settings: ProfitSettings = DEFAULT_PROFIT_SETTINGS): ProtectedOrder {
  const enabled = new Set<DiscountComponent>(["coupon", "referral", "bundle", "membership"]);
  const removed: DiscountComponent[] = [];

  for (;;) {
    const discount = resolveCustomerDiscount(inputs, enabled);
    const profit = computeProfit(inputs, discount);

    if (meetsFloor(profit, settings)) {
      return { ...profit, profitable: true, removed, blockedReason: null };
    }

    // Remove the lowest-priority discount still in play and try again.
    const next = REMOVAL_ORDER.find((component) => enabled.has(component) && discount.components.includes(component));
    if (!next) {
      // Nothing left to remove — the order loses money even at full price.
      return {
        ...profit,
        profitable: false,
        removed,
        blockedReason: "This order can't be completed at a profitable price. Promotion unavailable on this order.",
      };
    }
    enabled.delete(next);
    removed.push(next);
  }
}
