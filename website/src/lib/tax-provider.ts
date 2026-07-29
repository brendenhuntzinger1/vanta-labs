import "server-only";

// Server-side tax quoting seam — the ONE place the checkout (and anything
// else that needs an authoritative tax figure) asks "how much tax on this
// order?". Mirrors the email provider pattern (src/lib/email/provider.ts):
// the active backend is resolved from admin-editable settings, and swapping
// backends changes rates, never plumbing.
//
// Today the only live backend is the bundled state-level resolver in
// sales-tax.ts (the same pure function the client preview runs, so the
// preview and the server total always agree). The TaxJar / Avalara slots
// below are the integration seam: when one is selected in Control Center AND
// its credentials are present, quoteSalesTax routes to its adapter; until the
// adapter's HTTP call is implemented + verified, selection falls back to the
// builtin resolver so checkout NEVER breaks over a half-configured provider.
//
// Wiring notes for the future adapter (kept here so the integration is a
// contained change):
//   TaxJar:  POST https://api.taxjar.com/v2/taxes
//            { to_state, to_zip, to_city, to_street, amount, shipping }
//            → response.tax.amount_to_collect / .rate
//   Avalara: POST /api/v2/transactions/create (CreateTransaction, type
//            SalesOrder for quotes) → totalTax
// Both must degrade to the builtin quote on timeout/error — tax lookup being
// down must never block a sale.

import { getSalesTaxSettings, type SalesTaxSettings } from "@/lib/admin-control";
import { resolveSalesTax, type TaxQuote, type TaxQuoteInput } from "@/lib/sales-tax";

export interface OrderTaxRequest {
  /** Post-discount merchandise total. */
  taxableAmount: number;
  shippingAmount: number;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  postalCode?: string | null;
  street?: string | null;
}

export interface ResolvedOrderTax extends TaxQuote {
  /** Settings snapshot the quote was computed with (for status surfaces). */
  settings: SalesTaxSettings;
}

function builtinQuote(request: OrderTaxRequest, settings: SalesTaxSettings): TaxQuote {
  const input: TaxQuoteInput = {
    taxableAmount: request.taxableAmount,
    shippingAmount: request.shippingAmount,
    country: request.country,
    state: request.state,
    city: request.city,
    postalCode: request.postalCode,
    street: request.street,
    config: { nexusStates: settings.nexusStates, rateOverrides: settings.rateOverrides },
  };
  return resolveSalesTax(input);
}

// Authoritative order-time quote. Never throws: any config/lookup failure
// resolves to the builtin (or zero) quote rather than blocking checkout.
export async function quoteSalesTax(request: OrderTaxRequest): Promise<ResolvedOrderTax> {
  const settings = await getSalesTaxSettings();

  // Future: when settings.provider is "taxjar"/"avalara" AND the matching
  // credential is set, call the external adapter here and fall back to
  // builtin on error. Until then every selection resolves builtin.
  const quote = builtinQuote(request, settings);
  return { ...quote, settings };
}
