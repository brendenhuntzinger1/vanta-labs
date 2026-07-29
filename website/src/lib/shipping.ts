// Shared shipping math, imported identically by the client cart preview
// (cart-context.tsx, checkout/page.tsx) and the server checkout total
// (payment-service.ts) - same reasoning as bundle-pricing.ts: one formula,
// not two hand-synced copies, so client/server totals can never drift apart
// and trip the "Altered total detected" check.
//
// There is intentionally NO service/handling fee: the only charges added to
// merchandise are shipping (when under the free-shipping threshold) and sales
// tax. Do not reintroduce a handling/service fee here.

export const FREE_SHIPPING_THRESHOLD = 250;
export const DOMESTIC_SHIPPING_FEE = 15;
export const INTERNATIONAL_FREE_SHIPPING_THRESHOLD = 600;
export const INTERNATIONAL_SHIPPING_FEE = 60;
// North America (Canada) — a middle zone between the US and overseas. Only the
// US and Canada are shippable today; the international constants above are kept
// for the zone model but every non-US/Canada country is rejected at checkout.
export const NORTH_AMERICA_SHIPPING_FEE = 25;
export const NORTH_AMERICA_FREE_SHIPPING_THRESHOLD = 400;

// Admin-editable shipping settings. An admin sets these in Admin → Control
// Center → Shipping (stored in the "shipping" control section); the coded
// constants above are the defaults when a field is left blank. Passed
// identically into calculateShipping on both the client preview and the
// authoritative server total, so the two can never drift apart and trip the
// "Altered total detected" guard.
export interface ShippingConfig {
  domesticFee: number;
  freeShippingThreshold: number;
  northAmericaFee: number;
  northAmericaFreeShippingThreshold: number;
  internationalFee: number;
  internationalFreeShippingThreshold: number;
}

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  domesticFee: DOMESTIC_SHIPPING_FEE,
  freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
  northAmericaFee: NORTH_AMERICA_SHIPPING_FEE,
  northAmericaFreeShippingThreshold: NORTH_AMERICA_FREE_SHIPPING_THRESHOLD,
  internationalFee: INTERNATIONAL_SHIPPING_FEE,
  internationalFreeShippingThreshold: INTERNATIONAL_FREE_SHIPPING_THRESHOLD,
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

const NORTH_AMERICA_COUNTRY_NAMES = new Set([
  "canada", "ca", "can",
]);

export type ShippingZone = "domestic" | "north_america" | "international";

// Zones: US (domestic) and Canada (north_america) are the only shippable
// destinations; everything else is "international" and is NOT offered (blocked
// at checkout). Unknown/empty country defaults to domestic so the cart preview
// (before a shipping address is entered) matches prior behavior.
export function resolveShippingZone(country?: string | null): ShippingZone {
  if (isDomesticCountry(country)) return "domestic";
  if (NORTH_AMERICA_COUNTRY_NAMES.has((country ?? "").trim().toLowerCase())) return "north_america";
  return "international";
}

// The store ships ONLY to the United States and Canada. Used to gate the
// checkout country selector (UX) and to reject an out-of-area order on the
// server (authoritative).
export function isShippableCountry(country?: string | null): boolean {
  return resolveShippingZone(country) !== "international";
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

  const zone = resolveShippingZone(country);
  if (zone === "domestic") {
    return subtotal >= config.freeShippingThreshold ? 0 : config.domesticFee;
  }
  if (zone === "north_america") {
    // Defensive ?? so a stale/partial config (missing the newer fields) still
    // resolves to sane defaults instead of NaN.
    const fee = config.northAmericaFee ?? DEFAULT_SHIPPING_CONFIG.northAmericaFee;
    const threshold = config.northAmericaFreeShippingThreshold ?? DEFAULT_SHIPPING_CONFIG.northAmericaFreeShippingThreshold;
    return subtotal >= threshold ? 0 : fee;
  }
  return subtotal >= config.internationalFreeShippingThreshold ? 0 : config.internationalFee;
}

// NOTE: the old flat-rate calculateTax(base, ratePercent) that lived here is
// gone. Sales tax is now dynamic — resolved from the shipping address (state
// nexus + destination rate) by src/lib/sales-tax.ts, shared client + server
// the same way the shipping math above is.
