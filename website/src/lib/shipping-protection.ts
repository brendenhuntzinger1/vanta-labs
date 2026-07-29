// "Shipping Protection" add-on (loss / theft / damage coverage).
//
// Shared by the client cart/checkout preview AND the authoritative server total
// (same one-formula rule as shipping.ts / bundle-pricing.ts) so the fee a
// shopper sees is always exactly what the server charges — no drift, no tripping
// the "Altered total detected" guard.
//
// Pricing: a flat PERCENTAGE of the merchandise subtotal (replaces the old
// $2.49/$3.49/$4.99 tiers), so coverage cost scales with the value being
// protected. Protection is ADDED BY DEFAULT in the cart/checkout UI but stays
// strictly optional — one visible, pre-announced checkbox untick removes it
// and the fee disappears immediately.

export const SHIPPING_PROTECTION_PERCENT = 3;

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
