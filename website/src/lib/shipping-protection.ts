// "Shipping Protection" add-on (loss / theft / damage coverage).
//
// Shared by the client cart/checkout preview AND the authoritative server total
// (same one-formula rule as shipping.ts / bundle-pricing.ts) so the fee a
// shopper sees is always exactly what the server charges — no drift, no tripping
// the "Altered total detected" guard.
//
// Pricing: a flat PERCENTAGE of the merchandise subtotal (replaces the old
// $2.49/$3.49/$4.99 tiers), so coverage cost scales with the value being
// protected.
//
// PRE-SELECTED BY DEFAULT — BUT ONLY WHERE THE SHOPPER CAN SEE AND REMOVE IT.
//
// Two rules, and they are load-bearing together rather than separately:
//
//   1. The cart drawer, /cart and /checkout start with protection ON. Each of
//      those surfaces renders a checkbox with the fee beside it and removes the
//      charge in one click, and the published Shipping Policy says so in the
//      store's own words. Code and policy are two halves of one promise: change
//      this default and legal-content.ts changes in the same commit.
//      See shipping-protection-default.test.ts.
//
//   2. Express/wallet checkout (Apple Pay, Google Pay) does NOT inherit that
//      default. A wallet can go from tap to authorized payment without ever
//      rendering our checkbox, so protection rides along there only when the
//      shopper explicitly chose it first — cart-context exposes
//      `shippingProtectionChosen` for exactly this, and the express button
//      sends that rather than `shippingProtectionEnabled`.
//      See shipping-protection-wallet.test.ts.
//
// Rule 2 is what keeps rule 1 honest. Pre-ticking an add-on the shopper can see
// and untick is a default; pre-ticking one they never see before paying is a
// silent charge, and the two are only distinguishable by which surface is
// asking.
//
// Pricing: a flat PERCENTAGE of the merchandise subtotal, admin-adjustable in
// Control Center -> Shipping -> "Shipping protection rate (%)". The rate is
// carried on ShippingConfig, so the client preview and the authoritative server
// total (quote-order.ts) read the one number and cannot drift. The constant
// below is only the fallback for a blank/absent setting.
//
// The UI shows the DOLLAR amount of the fee next to the checkbox but not the
// percentage, per the owner's preference. That amount is what protection costs
// whether or not the box is currently ticked — computed from the subtotal, not
// from the tick — so a shopper who unticks it still sees the real price of
// putting it back rather than $0.00.
// See shipping-protection-offer-price.test.ts.

export const SHIPPING_PROTECTION_PERCENT = 6;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

// The protection fee for a given merchandise subtotal. Returns 0 for an empty
// cart. Callers apply this only when protection is (still) selected.
export function calculateShippingProtectionFee(
  subtotal: number,
  percent: number = SHIPPING_PROTECTION_PERCENT,
): number {
  if (subtotal <= 0 || percent <= 0) return 0;
  return roundMoney(subtotal * (percent / 100));
}
