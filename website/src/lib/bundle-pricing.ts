// Quantity-based "Bundle & Save" pricing. This is the single source of
// truth for the discount math - imported by both the client cart
// (cart-context.tsx, product-detail-client.tsx) and the server checkout
// (payment-service.ts) so the total a shopper sees is always exactly what
// the server charges. Never duplicate this formula elsewhere.
//
// The two discount rates are admin-editable (Control Center → Promotions).
// Every function takes an optional config and falls back to DEFAULT_BUNDLE_CONFIG
// so existing callers and tests keep the original 5% / 8% behavior unless an
// admin changes it — and client + server always pass the SAME config (the
// client fetches it from /api/catalog/promotions, the PDP receives it as a
// server prop) so the preview can never diverge from the charge.

export type BundleConfig = {
  // Rates as fractions (0.05 = 5%). twoUnit applies at exactly 2 units;
  // threePlus applies at 3 or more.
  twoUnitPercent: number;
  threePlusPercent: number;
};

export const DEFAULT_BUNDLE_CONFIG: BundleConfig = {
  twoUnitPercent: 0.05,
  threePlusPercent: 0.08,
};

export function bundleDiscountRate(quantity: number, config: BundleConfig = DEFAULT_BUNDLE_CONFIG): number {
  if (quantity >= 3) return config.threePlusPercent;
  if (quantity === 2) return config.twoUnitPercent;
  return 0;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getBundleDiscountedUnitPrice(unitPrice: number, quantity: number, config: BundleConfig = DEFAULT_BUNDLE_CONFIG): number {
  return roundMoney(unitPrice * (1 - bundleDiscountRate(quantity, config)));
}

export function getBundleDiscountedLineTotal(unitPrice: number, quantity: number, config: BundleConfig = DEFAULT_BUNDLE_CONFIG): number {
  return roundMoney(getBundleDiscountedUnitPrice(unitPrice, quantity, config) * quantity);
}

// Clamp an admin-entered whole-number percent (e.g. 5 or 8) into a safe rate
// fraction in [0, 0.9]. Blank/invalid falls back to the provided default rate.
function toRate(value: unknown, fallbackRate: number): number {
  // A blank/empty field means "keep the default" — NOT 0%. Only an explicit,
  // valid, non-negative number overrides the default.
  if (value === "" || value == null) return fallbackRate;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackRate;
  return Math.min(0.9, parsed / 100);
}

// Build a BundleConfig from admin control values (whole-number percents).
export function resolveBundleConfig(input: { twoUnitPercent?: unknown; threePlusPercent?: unknown }): BundleConfig {
  return {
    twoUnitPercent: toRate(input.twoUnitPercent, DEFAULT_BUNDLE_CONFIG.twoUnitPercent),
    threePlusPercent: toRate(input.threePlusPercent, DEFAULT_BUNDLE_CONFIG.threePlusPercent),
  };
}
