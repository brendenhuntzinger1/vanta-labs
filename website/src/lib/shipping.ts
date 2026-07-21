// Shared shipping + handling fee math, imported identically by the client
// cart preview (cart-context.tsx, checkout/page.tsx) and the server
// checkout total (payment-service.ts) - same reasoning as bundle-pricing.ts:
// one formula, not two hand-synced copies, so client/server totals can never
// drift apart and trip the "Altered total detected" check.

export const FREE_SHIPPING_THRESHOLD = 250;
export const DOMESTIC_SHIPPING_FEE = 15;
export const INTERNATIONAL_FREE_SHIPPING_THRESHOLD = 600;
export const INTERNATIONAL_SHIPPING_FEE = 60;
export const HANDLING_FEE_RATE = 0.05;

// Admin-editable shipping + service-fee settings. An admin sets these in
// Admin → Control Center → Shipping (stored in the "shipping" control
// section); the coded constants above are the defaults when a field is left
// blank. Passed identically into calculateShipping/calculateHandlingFee on
// both the client preview and the authoritative server total, so the two can
// never drift apart and trip the "Altered total detected" guard.
export interface ShippingConfig {
  domesticFee: number;
  freeShippingThreshold: number;
  internationalFee: number;
  internationalFreeShippingThreshold: number;
  // Service/handling fee as a fraction of subtotal (0.05 = 5%). 0 disables it.
  handlingFeeRate: number;
}

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  domesticFee: DOMESTIC_SHIPPING_FEE,
  freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
  internationalFee: INTERNATIONAL_SHIPPING_FEE,
  internationalFreeShippingThreshold: INTERNATIONAL_FREE_SHIPPING_THRESHOLD,
  handlingFeeRate: HANDLING_FEE_RATE,
};

const DOMESTIC_COUNTRY_NAMES = new Set([
  "united states",
  "united states of america",
  "usa",
  "us",
  "u.s.",
  "u.s.a.",
]);

// Defaults to domestic when no country is known yet (e.g. the cart preview,
// before checkout collects a shipping address) to match prior behavior.
export function isDomesticCountry(country?: string | null): boolean {
  if (!country || !country.trim()) return true;
  return DOMESTIC_COUNTRY_NAMES.has(country.trim().toLowerCase());
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateShipping(
  subtotal: number,
  country?: string | null,
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG,
): number {
  if (subtotal <= 0) return 0;

  if (isDomesticCountry(country)) {
    return subtotal >= config.freeShippingThreshold ? 0 : config.domesticFee;
  }

  return subtotal >= config.internationalFreeShippingThreshold ? 0 : config.internationalFee;
}

export function calculateHandlingFee(
  subtotal: number,
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG,
): number {
  if (subtotal <= 0 || !config.handlingFeeRate || config.handlingFeeRate <= 0) return 0;
  return roundMoney(subtotal * config.handlingFeeRate);
}

// Configurable sales tax, applied to the post-discount merchandise total.
// Shared client + server so the checkout preview and the authoritative server
// total always agree (see the "Altered total detected" guard). Default rate is
// 0 (no tax) until an admin sets one in Admin → Control Center.
export function calculateTax(taxableBase: number, ratePercent: number): number {
  if (taxableBase <= 0 || !ratePercent || ratePercent <= 0) return 0;
  return roundMoney(taxableBase * (ratePercent / 100));
}
