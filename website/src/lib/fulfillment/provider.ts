import "server-only";

import type { FulfillmentRuntimeConfig } from "@/lib/fulfillment/config";

// The buyer's real email must never reach the 3PL — see contact-email.ts.
export { fulfillmentContactEmail } from "@/lib/fulfillment/contact-email";

export interface NormalizedFulfillmentOrder {
  orderId: string;
  orderNumber: string;
  /**
   * NEVER the buyer's address — see fulfillmentContactEmail above.
   */
  customer: { name: string; email: string };
  /** `state` is required for any US label — carriers reject a domestic address without it. */
  shipping: { address: string; city: string; state: string; postalCode: string; country: string };
  // `sku` is the base product SKU (product slug) — the SAME key the inbound
  // inventory-sync webhook matches on, so stock stays consistent. `variant`
  // carries the specific dose/option when the product has variants, so the 3PL
  // can pick the right pack without the SKU itself changing.
  //
  // `variant` alone is this store's internal product_doses.id — a UUID that is
  // meaningless in anyone else's catalog. A vial label is per-STRENGTH (a 5mg
  // label is not a 10mg label), so a 3PL keying its label template on a SKU has
  // nothing to match for a dosed product: it receives "glp-1" plus a UUID. A
  // single-dose product like MOTS-C has no variant at all, so its plain slug
  // matches and its label prints — which is exactly the asymmetry reported
  // (MOTS-C could print a vial label, GLP-1 5mg could not).
  //
  // So the dose's own catalogue identity travels with the line: `variantSku`
  // (product_doses.sku), `variantLabel` ("5mg"), and `batchNumber` for the
  // label itself. Added ALONGSIDE sku/variant rather than replacing them, so
  // the inventory-sync contract is untouched.
  items: Array<{
    sku: string | null;
    variant: string | null;
    variantSku: string | null;
    variantLabel: string | null;
    batchNumber: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  notes: string;
  totals: { subtotal: number; shipping: number; tax: number; total: number };
}

export interface FulfillmentResult {
  ok: boolean;
  externalId?: string;
  status: string; // queued | sent | accepted | error
  statusCode?: number;
  message?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  raw?: unknown;
}

export interface FulfillmentProvider {
  readonly name: string;
  createFulfillmentOrder(order: NormalizedFulfillmentOrder): Promise<FulfillmentResult>;
}

// No-API default. Records the order as queued so payout reports/invoices can be
// generated; a human (or a later API integration) does the actual handoff.
export class ManualFulfillmentProvider implements FulfillmentProvider {
  readonly name = "manual";
  async createFulfillmentOrder(): Promise<FulfillmentResult> {
    return { ok: true, status: "queued", message: "Queued for manual fulfillment (no 3PL API configured)." };
  }
}

// Generic REST adapter — works with any 3PL that accepts a standard order
// payload at POST {apiBaseUrl}/orders with a Bearer token. Switching providers
// is just new credentials; only a genuinely non-standard API needs its own
// adapter class implementing FulfillmentProvider.
export class GenericRestFulfillmentProvider implements FulfillmentProvider {
  readonly name: string;
  constructor(private readonly config: Pick<FulfillmentRuntimeConfig, "apiBaseUrl" | "apiKey" | "providerName">) {
    this.name = config.providerName || "generic_rest";
  }

  async createFulfillmentOrder(order: NormalizedFulfillmentOrder): Promise<FulfillmentResult> {
    if (!this.config.apiBaseUrl || !this.config.apiKey) {
      return { ok: false, status: "error", message: "3PL API base URL or key is not configured." };
    }

    try {
      const response = await fetch(`${this.config.apiBaseUrl}/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_number: order.orderNumber,
          reference: order.orderId,
          customer: order.customer,
          shipping_address: order.shipping,
          line_items: order.items.map((item) => ({
            sku: item.sku,
            variant: item.variant,
            // The dose's real catalogue SKU / strength / batch — what a vial
            // label is keyed and printed from.
            variant_sku: item.variantSku,
            variant_label: item.variantLabel,
            dose: item.variantLabel,
            batch_number: item.batchNumber,
            name: item.name,
            quantity: item.quantity,
            unit_price: item.unitPrice,
          })),
          notes: order.notes,
          totals: order.totals,
        }),
      });

      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ok: false,
          status: "error",
          statusCode: response.status,
          message: `3PL API error (${response.status})`,
          raw,
        };
      }

      // Best-effort field extraction — different 3PLs name these differently.
      const record = (raw ?? {}) as Record<string, unknown>;
      const externalId = String(record.id ?? record.order_id ?? record.reference ?? "") || undefined;
      const trackingNumber = String(record.tracking_number ?? record.tracking ?? "") || undefined;
      const trackingUrl = String(record.tracking_url ?? "") || undefined;
      const carrier = String(record.carrier ?? "") || undefined;

      return {
        ok: true,
        status: "sent",
        statusCode: response.status,
        externalId,
        trackingNumber,
        trackingUrl,
        carrier,
        raw,
      };
    } catch (error) {
      return { ok: false, status: "error", message: error instanceof Error ? error.message : "3PL request failed" };
    }
  }
}

export function getFulfillmentProvider(config: FulfillmentRuntimeConfig): FulfillmentProvider {
  if (config.mode === "generic_rest") {
    return new GenericRestFulfillmentProvider(config);
  }
  return new ManualFulfillmentProvider();
}
