// Dynamic, address-based US sales tax — shared by the client checkout preview
// (checkout/page.tsx) and the authoritative server total (payment-service.ts),
// exactly like shipping.ts: ONE formula, imported by both sides, so the
// preview and the server can never drift apart and trip the "Altered total
// detected" guard.
//
// Model
// -----
// • Tax is collected ONLY for destinations where the store is configured to
//   have sales-tax nexus (admin-set state list). Shipping to any other state
//   collects $0 — a merchant must not collect tax it has no obligation (or
//   registration) to remit.
// • The rate applied is the destination state's combined average rate
//   (state base + population-weighted average of local county/city/district
//   rates, published by the Tax Foundation, mid-2025). An admin can override
//   any state's rate in Control Center → Sales tax when they know a better
//   figure for their shipping mix.
// • States that tax delivery charges on taxable goods also tax the shipping
//   fee; the rest tax merchandise only.
// • Non-US destinations collect $0 (the store is not registered for Canadian
//   GST/HST; Canada support belongs in a provider integration).
//
// Exact street/ZIP-level ("rooftop") rates require a live rate service —
// that is what a TaxJar / Avalara integration provides. This module is the
// built-in resolver AND the shared input/output contract those providers
// implement (see tax-provider.ts): the full address, including ZIP, flows
// through TaxQuoteInput so switching providers changes rates, not plumbing.

import { roundMoney } from "@/lib/shipping";
import { isDomesticCountry } from "@/lib/shipping";

export interface StateTaxRule {
  /** Combined average sales-tax rate percent (state + avg local). */
  ratePercent: number;
  /** Whether separately-stated shipping on taxable goods is itself taxable. */
  shippingTaxable: boolean;
}

// Combined state + average local rates (percent), Tax Foundation mid-2025.
// NOMAD states (NH, OR, MT, DE) have no state sales tax; Alaska has no state
// rate but localities levy an average ~1.8% — it is included so an Alaska
// nexus (rare) still computes something sensible.
export const US_STATE_TAX_TABLE: Record<string, StateTaxRule> = {
  AL: { ratePercent: 9.29, shippingTaxable: false },
  AK: { ratePercent: 1.82, shippingTaxable: false },
  AZ: { ratePercent: 8.38, shippingTaxable: false },
  AR: { ratePercent: 9.45, shippingTaxable: true },
  CA: { ratePercent: 8.85, shippingTaxable: false },
  CO: { ratePercent: 7.81, shippingTaxable: false },
  CT: { ratePercent: 6.35, shippingTaxable: true },
  DE: { ratePercent: 0, shippingTaxable: false },
  DC: { ratePercent: 6.0, shippingTaxable: true },
  FL: { ratePercent: 7.0, shippingTaxable: false },
  GA: { ratePercent: 7.38, shippingTaxable: true },
  HI: { ratePercent: 4.5, shippingTaxable: true },
  ID: { ratePercent: 6.03, shippingTaxable: false },
  IL: { ratePercent: 8.86, shippingTaxable: false },
  IN: { ratePercent: 7.0, shippingTaxable: true },
  IA: { ratePercent: 6.94, shippingTaxable: false },
  KS: { ratePercent: 8.65, shippingTaxable: true },
  KY: { ratePercent: 6.0, shippingTaxable: true },
  LA: { ratePercent: 10.11, shippingTaxable: false },
  ME: { ratePercent: 5.5, shippingTaxable: false },
  MD: { ratePercent: 6.0, shippingTaxable: false },
  MA: { ratePercent: 6.25, shippingTaxable: false },
  MI: { ratePercent: 6.0, shippingTaxable: true },
  MN: { ratePercent: 8.04, shippingTaxable: true },
  MS: { ratePercent: 7.06, shippingTaxable: true },
  MO: { ratePercent: 8.39, shippingTaxable: false },
  MT: { ratePercent: 0, shippingTaxable: false },
  NE: { ratePercent: 6.97, shippingTaxable: true },
  NV: { ratePercent: 8.24, shippingTaxable: false },
  NH: { ratePercent: 0, shippingTaxable: false },
  NJ: { ratePercent: 6.63, shippingTaxable: true },
  NM: { ratePercent: 7.62, shippingTaxable: true },
  NY: { ratePercent: 8.53, shippingTaxable: true },
  NC: { ratePercent: 7.0, shippingTaxable: true },
  ND: { ratePercent: 7.04, shippingTaxable: true },
  OH: { ratePercent: 7.24, shippingTaxable: true },
  OK: { ratePercent: 8.99, shippingTaxable: false },
  OR: { ratePercent: 0, shippingTaxable: false },
  PA: { ratePercent: 6.34, shippingTaxable: true },
  PR: { ratePercent: 11.5, shippingTaxable: false },
  RI: { ratePercent: 7.0, shippingTaxable: true },
  SC: { ratePercent: 7.5, shippingTaxable: true },
  SD: { ratePercent: 6.11, shippingTaxable: true },
  TN: { ratePercent: 9.55, shippingTaxable: true },
  TX: { ratePercent: 8.2, shippingTaxable: true },
  UT: { ratePercent: 7.32, shippingTaxable: false },
  VT: { ratePercent: 6.36, shippingTaxable: true },
  VA: { ratePercent: 5.77, shippingTaxable: false },
  WA: { ratePercent: 9.38, shippingTaxable: true },
  WV: { ratePercent: 6.57, shippingTaxable: true },
  WI: { ratePercent: 5.7, shippingTaxable: true },
  WY: { ratePercent: 5.56, shippingTaxable: false },
};

// Full-name → USPS code, so "Texas" (typed or autofilled) resolves the same
// as "TX". Keys are lowercase for case-insensitive lookup.
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  "washington dc": "DC", "washington d.c.": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "puerto rico": "PR",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** "Texas" / "tx" / " TX " → "TX"; unknown/empty → null. */
export function normalizeUsState(state?: string | null): string | null {
  const raw = (state ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (US_STATE_TAX_TABLE[upper]) return upper;
  const byName = STATE_NAME_TO_CODE[raw.toLowerCase()];
  return byName ?? null;
}

// Admin-configured tax posture, editable in Control Center → Sales tax and
// served to the storefront via /api/catalog/promotions (rates themselves ship
// with the bundle; only this small config travels).
export interface SalesTaxConfig {
  /** States (USPS codes) where the store has nexus and MUST collect. */
  nexusStates: string[];
  /** Per-state rate overrides (percent) an admin sets to pin a better rate. */
  rateOverrides: Record<string, number>;
}

export const DEFAULT_SALES_TAX_CONFIG: SalesTaxConfig = {
  nexusStates: [],
  rateOverrides: {},
};

// The full shared quote contract. Street/city/ZIP are carried (not used by the
// built-in state-level resolver) so a rooftop-accurate provider — TaxJar,
// Avalara — plugs in without changing any call site.
export interface TaxQuoteInput {
  /** Post-discount merchandise total (the taxable sale amount). */
  taxableAmount: number;
  /** Shipping charged to the customer (taxed only where shipping is taxable). */
  shippingAmount: number;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  postalCode?: string | null;
  street?: string | null;
  config: SalesTaxConfig;
}

export interface TaxQuote {
  /** Dollars of sales tax to collect on this order. */
  amount: number;
  /** Rate percent applied (0 when not collecting). */
  ratePercent: number;
  /** Normalized destination state code, when resolvable. */
  state: string | null;
  /** Base the rate was applied to (merch + shipping where taxable). */
  taxableBase: number;
  /** True when the destination is in a configured nexus state. */
  collected: boolean;
  /** Machine-readable reason when NOT collecting. */
  reason: "collected" | "no_nexus" | "no_state" | "non_us" | "zero_rate" | "zero_base";
  /** Which resolver produced the quote (a future provider sets its own id). */
  source: "builtin";
}

const ZERO_QUOTE: Omit<TaxQuote, "reason" | "state"> = {
  amount: 0,
  ratePercent: 0,
  taxableBase: 0,
  collected: false,
  source: "builtin",
};

// The one shared entry point. Pure and synchronous so the checkout page can
// recompute it on every keystroke of the address form; the server calls the
// exact same function (via tax-provider.ts) when it builds the real order.
export function resolveSalesTax(input: TaxQuoteInput): TaxQuote {
  const state = normalizeUsState(input.state);
  const taxable = Math.max(0, roundMoney(input.taxableAmount));

  if (!isDomesticCountry(input.country)) {
    return { ...ZERO_QUOTE, state, reason: "non_us" };
  }
  if (taxable <= 0) {
    return { ...ZERO_QUOTE, state, reason: "zero_base" };
  }
  if (!state) {
    return { ...ZERO_QUOTE, state: null, reason: "no_state" };
  }

  const nexus = new Set((input.config.nexusStates ?? []).map((s) => normalizeUsState(s)).filter(Boolean));
  if (!nexus.has(state)) {
    return { ...ZERO_QUOTE, state, reason: "no_nexus" };
  }

  const rule = US_STATE_TAX_TABLE[state];
  const override = input.config.rateOverrides?.[state];
  const ratePercent = typeof override === "number" && Number.isFinite(override) && override >= 0
    ? override
    : rule.ratePercent;
  if (ratePercent <= 0) {
    return { ...ZERO_QUOTE, state, reason: "zero_rate" };
  }

  const shipping = Math.max(0, roundMoney(input.shippingAmount));
  const taxableBase = roundMoney(taxable + (rule.shippingTaxable ? shipping : 0));
  return {
    amount: calculateTaxAmount(taxableBase, ratePercent),
    ratePercent,
    state,
    taxableBase,
    collected: true,
    reason: "collected",
    source: "builtin",
  };
}

// Primitive rate application, kept exported for the order-math test sweeps.
// (Previously lived in shipping.ts as calculateTax, applied at a flat
// storewide rate — the flat model is gone; this is now only the last step of
// resolveSalesTax above.)
export function calculateTaxAmount(taxableBase: number, ratePercent: number): number {
  if (taxableBase <= 0 || !ratePercent || ratePercent <= 0) return 0;
  return roundMoney(taxableBase * (ratePercent / 100));
}
