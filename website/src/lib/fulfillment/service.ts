import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { recordSystemAlert } from "@/lib/monitoring";
import { deliveryConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { getFulfillmentRuntimeConfig, type FulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import { getFulfillmentProvider, fulfillmentContactEmail, type NormalizedFulfillmentOrder } from "@/lib/fulfillment/provider";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";
import { getFulfillmentRelayDomain } from "@/lib/fulfillment/relay-domain";
import { getSiteUrl } from "@/lib/env";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export interface OrderRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  // customer_email is deliberately ABSENT. This row feeds the 3PL payload, and
  // the buyer's address must never be reachable from there — see
  // fulfillmentContactEmail. Leaving the field off makes reintroducing it a
  // COMPILE ERROR rather than a code-review catch. The inbound path, which
  // emails the buyer from Vanta, reads the address in its own query.
  shipping_address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  subtotal: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  amount_paid: number | null;
  order_items?: Array<{ product_id?: string | null; product_name?: string | null; quantity?: number | null; unit_price?: number | null }>;
}

// Total sellable units (vials) in an order — used for per-unit 3PL payouts.
export function countUnits(items: OrderRow["order_items"]): number {
  return (items ?? []).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
}

export function computePayoutOwed(config: Pick<FulfillmentRuntimeConfig, "payoutModel" | "payoutRate">, order: { amountPaid: number; units: number }): number {
  if (config.payoutModel === "percent") {
    return roundMoney(order.amountPaid * (config.payoutRate / 100));
  }
  return roundMoney(order.units * config.payoutRate);
}

async function logEvent(input: {
  orderId?: string | null;
  provider?: string;
  direction: "outbound" | "inbound";
  eventType: string;
  statusCode?: number;
  ok: boolean;
  message?: string;
  payload?: unknown;
}) {
  try {
    await supabaseAdmin.from("fulfillment_events").insert({
      order_id: input.orderId ?? null,
      provider: input.provider ?? null,
      direction: input.direction,
      event_type: input.eventType,
      status_code: input.statusCode ?? null,
      ok: input.ok,
      message: input.message ?? null,
      payload: (input.payload ?? null) as Record<string, unknown> | null,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Logging must never break the operation it describes.
  }
}

export function normalizeOrder(order: OrderRow, relayDomain: string): NormalizedFulfillmentOrder {
  return {
    orderId: order.order_id,
    orderNumber: order.order_number ?? order.order_id,
    // The buyer's real email is deliberately withheld — the 3PL emails its own
    // branded order confirmation to whatever address it is given. See
    // fulfillmentContactEmail. Falls back to an empty string rather than the
    // buyer's address when no relay domain is configured: no contact channel is
    // correct, the buyer's inbox is not.
    customer: {
      name: order.customer_name ?? "",
      email: fulfillmentContactEmail(order.order_number ?? order.order_id, relayDomain),
    },
    shipping: {
      address: order.shipping_address ?? "",
      city: order.city ?? "",
      postalCode: order.postal_code ?? "",
      country: order.country ?? "",
    },
    items: (order.order_items ?? []).map((item) => {
      // product_id is stored as either "slug" or "slug::variantId". The base
      // slug is the real SKU (and what inventory sync matches on); the suffix,
      // if any, is the chosen variant.
      const rawId = item.product_id ?? "";
      const [baseSku, variant] = rawId.split("::");
      return {
        sku: baseSku || null,
        variant: variant || null,
        name: item.product_name ?? "Item",
        quantity: Number(item.quantity ?? 0),
        unitPrice: Number(item.unit_price ?? 0),
      };
    }),
    notes: "",
    totals: {
      subtotal: Number(order.subtotal ?? 0),
      shipping: Number(order.shipping_amount ?? 0),
      tax: Number(order.tax_amount ?? 0),
      total: Number(order.amount_paid ?? 0),
    },
  };
}

// Records the payout owed for an order (upsert). Computed from the current
// payout model/rate. Kept separate from the money-movement status, which the
// admin controls on the payout dashboard.
async function recordPayout(order: OrderRow, config: FulfillmentRuntimeConfig) {
  const units = countUnits(order.order_items);
  const amountOwed = computePayoutOwed(config, { amountPaid: Number(order.amount_paid ?? 0), units });
  const now = new Date().toISOString();

  const { data: existing } = await supabaseAdmin
    .from("fulfillment_payouts")
    .select("id, status")
    .eq("order_id", order.order_id)
    .maybeSingle();

  const base = {
    order_id: order.order_id,
    order_number: order.order_number ?? order.order_id,
    provider: config.providerName,
    units,
    model: config.payoutModel,
    rate: config.payoutRate,
    amount_owed: amountOwed,
    updated_at: now,
  };

  if (existing) {
    // Don't overwrite a payout already marked paid/failed by the admin.
    if (existing.status === "paid") return;
    await supabaseAdmin.from("fulfillment_payouts").update(base).eq("order_id", order.order_id);
  } else {
    await supabaseAdmin.from("fulfillment_payouts").insert({ ...base, status: "pending", created_at: now });
  }
}

// Transmits a paid + verified order to the 3PL. Best-effort: never throws, so
// approving/paying an order is never blocked by a 3PL outage. Records a
// fulfillment_orders row and a payout row regardless of API success, and logs
// every attempt.
export async function transmitOrderToFulfillment(orderId: string): Promise<void> {
  try {
    const config = await getFulfillmentRuntimeConfig();
    if (!config.enabled) return;

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_name, shipping_address, city, postal_code, country, subtotal, shipping_amount, tax_amount, amount_paid, order_items(*)")
      .eq("order_id", orderId)
      .maybeSingle();

    if (!order) return;

    const relayDomain = await getFulfillmentRelayDomain();

    // Arcline rejects an order with no customer.email — 422 invalid_request
    // "A `customer.email` is required." Since we deliberately no longer send the
    // buyer's address, the per-order alias IS the email, and an unresolved relay
    // domain would send an empty one and strand EVERY paid order instead of the
    // occasional one. Alert before attempting so the cause is named rather than
    // arriving as an opaque 422.
    if (!relayDomain) {
      await recordSystemAlert({
        type: "fulfillment_config",
        severity: "critical",
        message:
          "No fulfilment contact domain resolved, so orders are transmitted with an empty customer email and the 3PL will reject them. "
          + "Set FULFILLMENT_CONTACT_DOMAIN, or an outbound email From address, or NEXT_PUBLIC_SITE_URL.",
        context: { orderId },
      });
    }

    const normalized = normalizeOrder(order as OrderRow, relayDomain);
    const now = new Date().toISOString();

    // Upsert the fulfillment order (idempotent per order).
    await supabaseAdmin
      .from("fulfillment_orders")
      .upsert(
        {
          order_id: order.order_id,
          order_number: order.order_number ?? order.order_id,
          provider: config.providerName,
          status: "queued",
          payload: normalized as unknown as Record<string, unknown>,
          updated_at: now,
        },
        { onConflict: "order_id" },
      );

    await recordPayout(order as OrderRow, config);

    if (!config.autoTransmit) {
      await logEvent({ orderId: order.order_id, provider: config.providerName, direction: "outbound", eventType: "order.queued", ok: true, message: "Auto-transmit off — queued." });
      return;
    }

    const provider = getFulfillmentProvider(config);
    const result = await provider.createFulfillmentOrder(normalized);

    await supabaseAdmin
      .from("fulfillment_orders")
      .update({
        provider: provider.name,
        status: result.ok ? result.status : "error",
        external_id: result.externalId ?? null,
        tracking_number: result.trackingNumber ?? null,
        tracking_url: result.trackingUrl ?? null,
        carrier: result.carrier ?? null,
        last_error: result.ok ? null : result.message ?? "Unknown error",
        transmitted_at: now,
        last_synced_at: now,
        updated_at: now,
      })
      .eq("order_id", order.order_id);

    await logEvent({
      orderId: order.order_id,
      provider: provider.name,
      direction: "outbound",
      eventType: result.ok ? "order.created" : "error",
      statusCode: result.statusCode,
      ok: result.ok,
      message: result.message,
      payload: result.raw,
    });

    // A paid order that fails to reach the 3PL is a critical incident — the
    // customer is charged but nothing ships. Surface it (durable alert + email).
    if (!result.ok) {
      await recordSystemAlert({
        type: "fulfillment_failed",
        severity: "critical",
        message: `Order ${order.order_id} failed to transmit to the 3PL — customer is paid but the order did not reach fulfillment.`,
        context: { orderId: order.order_id, provider: provider.name, error: result.message ?? null, statusCode: result.statusCode ?? null },
      });
    }
  } catch (error) {
    await logEvent({ orderId, direction: "outbound", eventType: "error", ok: false, message: error instanceof Error ? error.message : "transmit failed" });
    await recordSystemAlert({
      type: "fulfillment_failed",
      severity: "critical",
      message: `Order ${orderId} threw while transmitting to the 3PL.`,
      context: { orderId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

// -------------------------------------------------------------------------
// Inbound: apply a normalized event from the 3PL to our DB + admin. Called by
// the /api/webhooks/fulfillment route after verifying the signature.
// -------------------------------------------------------------------------
export interface InboundFulfillmentEvent {
  type: "status" | "tracking" | "inventory" | "cancelled" | "refund" | "error";
  orderRef?: string; // our order_id or order_number
  externalId?: string;
  status?: string; // shipped | delivered | processing | cancelled ...
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  message?: string;
  /**
   * Exact shipping-label cost, in cents, when the 3PL reports it (usually on a
   * shipped/label-purchased event). Drives estimate→exact profit reconciliation.
   */
  shippingCostCents?: number | null;
  /**
   * `sku` is the product slug; `variant` is this store's product_doses.id when the
   * 3PL is reporting a specific dose. Omitted/null means the product has no
   * options and stock applies at product level.
   */
  inventory?: Array<{ sku: string; variant?: string | null; quantity: number }>;
}

async function findFulfillmentOrder(event: InboundFulfillmentEvent) {
  if (event.orderRef) {
    // Sanitize before interpolating into PostgREST's .or() so a crafted
    // webhook value can't break out of the filter.
    const ref = String(event.orderRef).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    if (ref) {
      const { data } = await supabaseAdmin
        .from("fulfillment_orders")
        .select("order_id")
        .or(`order_id.eq.${ref},order_number.eq.${ref}`)
        .maybeSingle();
      if (data?.order_id) return String(data.order_id);
    }
  }
  if (event.externalId) {
    const { data } = await supabaseAdmin
      .from("fulfillment_orders")
      .select("order_id")
      .eq("external_id", event.externalId)
      .maybeSingle();
    if (data?.order_id) return String(data.order_id);
  }
  return null;
}

const STATUS_TO_FULFILLMENT: Record<string, string> = {
  processing: "processing",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export async function applyInboundFulfillmentEvent(event: InboundFulfillmentEvent): Promise<{ ok: boolean; message: string }> {
  const now = new Date().toISOString();

  // Inventory sync isn't tied to a single order. The 3PL is the source of
  // truth for quantity AND stock status: a reported quantity of 0 (or less)
  // flips the product — and all of its variants — to "Out of Stock"; anything
  // positive flips it back to "In Stock". This is the ONLY thing that marks a
  // product out of stock, so no manual inventory entry is ever required.
  if (event.type === "inventory" && event.inventory?.length) {
    // Apply PER DOSE when the 3PL names one.
    //
    // This previously wrote a single quantity to the product AND every one of its
    // doses, so a product with 10mg in stock and 5mg sold out reported both as
    // available — a customer could buy a dose the warehouse could not ship. The
    // 3PL now sends `variant` (this store's product_doses.id) alongside `sku`, so
    // each dose is set independently and only the product row is derived.
    const touchedProducts = new Set<string>();

    for (const item of event.inventory) {
      if (!item.sku) continue;
      const stockStatus = item.quantity <= 0 ? "Out of Stock" : "In Stock";

      const { data: product } = await supabaseAdmin
        .from("products")
        .select("id")
        .eq("slug", item.sku)
        .maybeSingle();
      if (!product?.id) continue;
      touchedProducts.add(String(product.id));

      if (item.variant) {
        // Scoped by product_id as well as id so a mismatched pair can never write
        // stock onto some other product's dose.
        await supabaseAdmin
          .from("product_doses")
          .update({ inventory_quantity: item.quantity, stock_status: stockStatus, updated_at: now })
          .eq("id", item.variant)
          .eq("product_id", product.id);
      } else {
        // No dose named: the product has no options, so product level IS the level.
        await supabaseAdmin
          .from("products")
          .update({ inventory_quantity: item.quantity, stock_status: stockStatus, updated_at: now })
          .eq("id", product.id);
        await supabaseAdmin
          .from("product_doses")
          .update({ inventory_quantity: item.quantity, stock_status: stockStatus, updated_at: now })
          .eq("product_id", product.id);
      }
    }

    // Derive each touched product from its doses: a product is sellable while ANY
    // enabled dose has stock, and its headline quantity is the total across them.
    // Deriving rather than trusting a sent product-level number keeps the product
    // row and its doses from ever disagreeing.
    for (const productId of touchedProducts) {
      const { data: doses } = await supabaseAdmin
        .from("product_doses")
        .select("inventory_quantity, is_enabled")
        .eq("product_id", productId);
      if (!doses?.length) continue;
      const live = doses.filter((d) => d.is_enabled !== false);
      const total = live.reduce((sum, d) => sum + Number(d.inventory_quantity ?? 0), 0);
      await supabaseAdmin
        .from("products")
        .update({
          inventory_quantity: total,
          stock_status: total > 0 ? "In Stock" : "Out of Stock",
          updated_at: now,
        })
        .eq("id", productId);
    }

    await logEvent({ direction: "inbound", eventType: "inventory.sync", ok: true, payload: event as unknown as Record<string, unknown> });
    return { ok: true, message: "Inventory synced." };
  }

  const orderId = await findFulfillmentOrder(event);
  if (!orderId) {
    await logEvent({ direction: "inbound", eventType: "error", ok: false, message: "Order not found for inbound event", payload: event as unknown as Record<string, unknown> });
    return { ok: false, message: "Order not found." };
  }

  const fulfillmentUpdate: Record<string, unknown> = { last_synced_at: now, updated_at: now };
  const orderUpdate: Record<string, unknown> = { updated_at: now };

  if (event.type === "cancelled") {
    fulfillmentUpdate.status = "cancelled";
    orderUpdate.fulfillment_status = "cancelled";
  } else if (event.type === "error") {
    fulfillmentUpdate.status = "error";
    fulfillmentUpdate.last_error = event.message ?? "3PL reported an error";
  } else {
    if (event.status) {
      fulfillmentUpdate.status = event.status;
      const mapped = STATUS_TO_FULFILLMENT[event.status.toLowerCase()];
      if (mapped) orderUpdate.fulfillment_status = mapped;
    }
    if (event.trackingNumber) {
      fulfillmentUpdate.tracking_number = event.trackingNumber;
      fulfillmentUpdate.tracking_url = event.trackingUrl ?? null;
      fulfillmentUpdate.carrier = event.carrier ?? null;
      orderUpdate.tracking_number = event.trackingNumber;
    }
  }

  // Read the order's current status + contact BEFORE updating, so we can email
  // the customer exactly once when it transitions into shipped/delivered.
  const { data: priorOrder } = await supabaseAdmin
    .from("orders")
    .select("fulfillment_status, customer_email, customer_name, order_number")
    .eq("order_id", orderId)
    .maybeSingle();

  await supabaseAdmin.from("fulfillment_orders").update(fulfillmentUpdate).eq("order_id", orderId);
  await supabaseAdmin.from("orders").update(orderUpdate).eq("order_id", orderId);

  // Reconcile the exact shipping-label cost into the order's profit the moment
  // the 3PL reports it (typically on the shipped / label-purchased event),
  // replacing the estimate and flipping the order to Finalized profit. Only when
  // an actual cost is present — a tracking number alone never finalizes profit.
  if (event.shippingCostCents != null && event.shippingCostCents >= 0) {
    await recordActualShippingCost({
      orderId,
      amountCents: event.shippingCostCents,
      source: "provider",
    }).catch(() => undefined);
  }

  // Customer shipping / delivery notifications — only on a genuine status
  // transition (prev !== new), so repeated 3PL webhooks never re-send.
  const newStatus = typeof orderUpdate.fulfillment_status === "string" ? orderUpdate.fulfillment_status : null;
  const prevStatus = priorOrder?.fulfillment_status ? String(priorOrder.fulfillment_status) : null;
  const customerEmail = priorOrder?.customer_email ? String(priorOrder.customer_email) : null;
  if (customerEmail && newStatus && newStatus !== prevStatus) {
    const displayOrderId = priorOrder?.order_number ? String(priorOrder.order_number) : orderId;
    try {
      if (newStatus === "shipped") {
        await sendEmail({
          to: customerEmail,
          ...shippingUpdateTemplate({
            customerName: String(priorOrder?.customer_name ?? ""),
            orderId: displayOrderId,
            status: "Shipped",
            carrier: event.carrier ?? undefined,
            trackingNumber: event.trackingNumber ?? undefined,
            // NOT event.trackingUrl. The 3PL sends its own storefront URL, so
            // "Track Package" was taking Vanta Labs customers to the fulfilment
            // provider's branded site. Derive the carrier's own link instead,
            // and when the carrier can't be identified keep the customer on
            // Vanta Labs rather than handing them off to another brand.
            trackingUrl:
              buildCarrierTrackingUrl(event.carrier, event.trackingNumber)
              ?? `${getSiteUrl()}/account/orders`,
          }),
        });
      } else if (newStatus === "delivered") {
        await sendEmail({
          to: customerEmail,
          ...deliveryConfirmationTemplate({ customerName: String(priorOrder?.customer_name ?? ""), orderId: displayOrderId }),
        });
      }
    } catch {
      // Notification is best-effort; the status update already persisted.
    }
  }

  // Mirror tracking into order_shipments so the existing admin order view and
  // customer shipping emails stay consistent.
  if (event.trackingNumber || orderUpdate.fulfillment_status) {
    await supabaseAdmin.from("order_shipments").upsert(
      {
        order_id: orderId,
        carrier: event.carrier ?? null,
        tracking_number: event.trackingNumber ?? null,
        shipping_status: String(orderUpdate.fulfillment_status ?? event.status ?? "processing"),
        updated_at: now,
      },
      { onConflict: "order_id" },
    );
  }

  await logEvent({
    orderId,
    direction: "inbound",
    eventType: `${event.type}${event.status ? `.${event.status}` : ""}`,
    ok: event.type !== "error",
    message: event.message,
    payload: event as unknown as Record<string, unknown>,
  });

  return { ok: true, message: "Applied." };
}
