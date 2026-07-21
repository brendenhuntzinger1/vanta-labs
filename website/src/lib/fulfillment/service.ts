import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { deliveryConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { getFulfillmentRuntimeConfig, type FulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import { getFulfillmentProvider, type NormalizedFulfillmentOrder } from "@/lib/fulfillment/provider";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

interface OrderRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
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

function normalizeOrder(order: OrderRow): NormalizedFulfillmentOrder {
  return {
    orderId: order.order_id,
    orderNumber: order.order_number ?? order.order_id,
    customer: { name: order.customer_name ?? "", email: order.customer_email ?? "" },
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
      .select("order_id, order_number, customer_name, customer_email, shipping_address, city, postal_code, country, subtotal, shipping_amount, tax_amount, amount_paid, order_items(*)")
      .eq("order_id", orderId)
      .maybeSingle();

    if (!order) return;

    const normalized = normalizeOrder(order as OrderRow);
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
  } catch (error) {
    await logEvent({ orderId, direction: "outbound", eventType: "error", ok: false, message: error instanceof Error ? error.message : "transmit failed" });
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
  inventory?: Array<{ sku: string; quantity: number }>;
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

  // Inventory sync isn't tied to a single order.
  if (event.type === "inventory" && event.inventory?.length) {
    for (const item of event.inventory) {
      if (!item.sku) continue;
      await supabaseAdmin.from("products").update({ inventory_quantity: item.quantity, updated_at: now }).eq("slug", item.sku);
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
            trackingUrl: event.trackingUrl ?? undefined,
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
