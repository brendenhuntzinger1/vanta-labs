import "server-only";

import type { FulfillmentRuntimeConfig } from "@/lib/fulfillment/config";

export interface NormalizedFulfillmentOrder {
  orderId: string;
  orderNumber: string;
  customer: { name: string; email: string };
  shipping: { address: string; city: string; postalCode: string; country: string };
  items: Array<{ sku: string | null; name: string; quantity: number; unitPrice: number }>;
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
