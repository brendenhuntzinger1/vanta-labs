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
// OFF BY DEFAULT, AND NEVER PRE-SELECTED. The published Shipping Policy says so
// in those words, so this is a promise to customers rather than a preference:
// pre-ticking a paid add-on while telling people in writing that it is never
// pre-ticked is what regulators call negative-option billing. This comment used
// to claim protection was "ADDED BY DEFAULT", which contradicted both the policy
// and the code (cart-context.tsx: useState(false)) — a future change made to
// match the comment would have reintroduced exactly that.
// See shipping-protection-default.test.ts.
//
// The UI shows the DOLLAR amount of the fee next to the checkbox but not the
// percentage, per the owner's preference. That amount is what ticking the box
// WOULD cost — computed from the subtotal, not from whether it is currently
// ticked — so the shopper decides against the real price rather than a $0.00
// that only becomes the real price once they have agreed to it.
// See shipping-protection-offer-price.test.ts.

export const SHIPPING_PROTECTION_PERCENT = 4;

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
