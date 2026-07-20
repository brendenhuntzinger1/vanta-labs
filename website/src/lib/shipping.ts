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

export function calculateShipping(subtotal: number, country?: string | null): number {
  if (subtotal <= 0) return 0;

  if (isDomesticCountry(country)) {
    return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : DOMESTIC_SHIPPING_FEE;
  }

  return subtotal >= INTERNATIONAL_FREE_SHIPPING_THRESHOLD ? 0 : INTERNATIONAL_SHIPPING_FEE;
}

export function calculateHandlingFee(subtotal: number): number {
  if (subtotal <= 0) return 0;
  return roundMoney(subtotal * HANDLING_FEE_RATE);
}
