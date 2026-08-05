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
  // The pair the integration contract is written around
  // (docs/3PL-INTEGRATION-REQUIREMENTS.md §5): "Our `sku` is the product slug
  // (e.g. `glp-1`) and `variant` is the dose (e.g. `5mg`). Inventory callbacks
  // must match on the same pair."
  //
  // `variant` was sending this store's internal product_doses.id — a UUID that
  // means nothing in anyone else's catalogue and is not what the partner was
  // told to expect. Two consequences, both observed:
  //
  //  - A vial label is per-STRENGTH (a 5mg label is not a 10mg label), so a
  //    partner keying a label template on the dose had a UUID where "5mg"
  //    should have been, and offered no "print vial label" for dosed products.
  //    A single-dose product like MOTS-C has no variant at all, so its plain
  //    slug identified the vial and its label printed — exactly the asymmetry
  //    reported from the warehouse.
  //  - Inventory sync: a partner following the written spec sends
  //    `variant: "5mg"`, which never matched a UUID column, so dose-level stock
  //    silently never updated.
  //
  // `variant` is now the dose as documented. `variantId` carries the internal
  // id for round-tripping, and `variantSku` / `batchNumber` give a label
  // template the dose's own catalogue identity and batch.
  items: Array<{
    sku: string | null;
    /** The DOSE, e.g. "5mg" — the contract's `variant`. */
    variant: string | null;
    /** Our internal product_doses.id, for round-tripping only. */
    variantId: string | null;
    variantSku: string | null;
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
            // The dose, per the contract — "5mg", not a UUID.
            variant: item.variant,
            dose: item.variant,
            // The dose's catalogue SKU and batch, for the vial label itself.
            variant_sku: item.variantSku,
            batch_number: item.batchNumber,
            // Our internal id, so a callback can round-trip it if preferred.
            variant_id: item.variantId,
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
