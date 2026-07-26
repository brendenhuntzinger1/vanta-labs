// Optional "Shipping Protection" add-on (loss / theft / damage coverage).
//
// Shared by the client cart/checkout preview AND the authoritative server total
// (same one-formula rule as shipping.ts / bundle-pricing.ts) so the fee a
// shopper sees is always exactly what the server charges — no drift, no tripping
// the "Altered total detected" guard.
//
// Pricing is tiered on the merchandise subtotal and lives in ONE config object
// so the amounts can be changed later (or made admin-editable) without touching
// the math. Default is OFF — the customer opts in.

export interface ShippingProtectionConfig {
  /** Fee for orders under the mid threshold. */
  baseFee: number;
  /** Fee once subtotal reaches midThreshold (inclusive). */
  midFee: number;
  /** Fee once subtotal reaches highThreshold (inclusive). */
  highFee: number;
  midThreshold: number;
  highThreshold: number;
}

export const DEFAULT_SHIPPING_PROTECTION_CONFIG: ShippingProtectionConfig = {
  baseFee: 2.49, // subtotal < $200
  midFee: 3.49, //  $200 ≤ subtotal < $350
  highFee: 4.99, // subtotal ≥ $350
  midThreshold: 200,
  highThreshold: 350,
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

// The protection fee for a given merchandise subtotal. Returns 0 for an empty
// cart. Callers apply this only when the customer has opted in.
export function calculateShippingProtectionFee(
  subtotal: number,
  config: ShippingProtectionConfig = DEFAULT_SHIPPING_PROTECTION_CONFIG,
): number {
  if (subtotal <= 0) return 0;
  if (subtotal >= config.highThreshold) return roundMoney(config.highFee);
  if (subtotal >= config.midThreshold) return roundMoney(config.midFee);
  return roundMoney(config.baseFee);
}
