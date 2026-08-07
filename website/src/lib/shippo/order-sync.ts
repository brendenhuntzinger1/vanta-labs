import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getShippingAddresses } from "@/lib/shipping-origin";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { createShipmentWithRates, createShippoOrder } from "@/lib/shippo/client";
import { isShippoConfigured } from "@/lib/shippo/config";
import { buildOrderParcel, toCountryCode } from "@/lib/shippo/service";
import type { ShippoAddress, ShippoOrderLineItem, ShippoTransactionCreated } from "@/lib/shippo/types";

// ---------------------------------------------------------------------------
// Pushing orders INTO Shippo, and receiving the label back OUT of it.
//
// The owner buys labels in Shippo's own dashboard. So this module runs in two
// directions, and the second one is the delicate half:
//
//   OUT  syncOrderToShippo()      paid order -> Shippo's Orders tab, populated
//                                 with address, line items and parcel weight so
//                                 nothing has to be retyped.
//
//   IN   applyTransactionCreated() a label was bought -- by a human, in Shippo,
//                                 in a purchase this system did not initiate --
//                                 and its real cost and tracking come back here.
//
// The inbound half is where the care goes. We are told about a purchase after
// the money is already spent, so the only question that matters is: WHICH order
// is this? A wrong answer silently attaches a real cost to the wrong customer's
// profit, and nothing about it looks broken afterwards.
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | { ok: true; shippoOrderId: string; created: boolean }
  | { ok: false; reason: string; retryable: boolean };

interface OrderRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
  phone: string | null;
  shipping_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  subtotal: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  amount_paid: number | null;
  currency: string | null;
  paid_at: string | null;
  payment_status: string | null;
  order_type: string | null;
  shippo_order_id: string | null;
}

const ORDER_COLUMNS =
  "order_id, order_number, customer_name, customer_email, phone, shipping_address, city, state, postal_code, country, subtotal, shipping_amount, tax_amount, amount_paid, currency, paid_at, payment_status, order_type, shippo_order_id";

function money(value: number | null | undefined): string {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}


/** ShippingAddress -> the shape Shippo wants. Empty optionals are omitted
 *  rather than sent blank, which Shippo treats as a validation failure. */
function toShippoAddress(a: {
  name: string; company: string; street1: string; street2: string;
  city: string; state: string; zip: string; country: string; phone: string; email: string;
}): ShippoAddress {
  return {
    name: a.name,
    company: a.company || undefined,
    street1: a.street1,
    street2: a.street2 || undefined,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country || "US",
    phone: a.phone || undefined,
    email: a.email || undefined,
  };
}

function destinationAddress(order: OrderRow): ShippoAddress {
  return {
    name: order.customer_name ?? "",
    street1: order.shipping_address ?? "",
    city: order.city ?? "",
    state: order.state ?? "",
    zip: order.postal_code ?? "",
    country: toCountryCode(order.country),
    phone: order.phone ?? undefined,
    email: order.customer_email ?? undefined,
  };
}

/**
 * Claim the right to push this order, exactly once.
 *
 * Creating a Shippo order costs nothing, but a DUPLICATE is genuinely harmful:
 * the owner opens the Orders tab and sees the same shipment twice with no way
 * to tell which one to buy against, and buying against both spends postage
 * twice for one parcel.
 *
 * Same single conditional UPDATE used for the label purchase and for paid
 * side-effects. Postgres serializes concurrent updates on the row, so exactly
 * one caller sees a returned row.
 */
async function claimSync(orderId: string): Promise<"won" | "lost" | "error"> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ shippo_sync_claimed_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("shippo_sync_claimed_at", null)
    .select("id");
  if (error) {
    console.error("Shippo sync claim failed for order", orderId, error);
    // Fail closed: an unknown claim state must never read as "go ahead".
    return "error";
  }
  return data && data.length > 0 ? "won" : "lost";
}

async function releaseSync(orderId: string, reason: string): Promise<void> {
  await supabaseAdmin
    .from("orders")
    .update({
      shippo_sync_claimed_at: null,
      shippo_sync_status: "error",
      shippo_sync_error: reason.slice(0, 500),
    })
    .eq("order_id", orderId);
}

/**
 * Push a paid order into Shippo's Orders tab.
 *
 * Safe to call automatically on payment: creating an order in Shippo is a
 * record, not a purchase. No postage is bought and no money moves.
 */
export async function syncOrderToShippo(orderId: string): Promise<SyncOutcome> {
  if (!isShippoConfigured()) {
    return { ok: false, reason: "Shippo is not configured.", retryable: true };
  }

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle<OrderRow>();

  if (error || !order) {
    return { ok: false, reason: "Order not found.", retryable: false };
  }

  // Already pushed. Short-circuit BEFORE claiming so a retry after a successful
  // sync is a cheap no-op rather than a contended write.
  if (order.shippo_order_id) {
    return { ok: true, shippoOrderId: order.shippo_order_id, created: false };
  }

  if (String(order.payment_status ?? "").toLowerCase() !== "paid") {
    return { ok: false, reason: "Only paid orders are sent to Shippo.", retryable: false };
  }

  // Memberships are digital. Pushing one would put a shipment in the Orders tab
  // for something that will never be posted.
  if (String(order.order_type ?? "product") === "membership") {
    return { ok: false, reason: "Membership orders are not shipped.", retryable: false };
  }

  const addresses = await getShippingAddresses();
  if (!addresses.canRequestRates) {
    return {
      ok: false,
      reason: `Ship-from address incomplete: ${addresses.originValidation.missing.join(", ")}.`,
      retryable: true,
    };
  }

  const parcelResult = await buildOrderParcel(orderId);
  if (!parcelResult.ok) {
    return { ok: false, reason: parcelResult.message, retryable: true };
  }
  const parcel = parcelResult.data;

  const claim = await claimSync(orderId);
  if (claim === "error") {
    return { ok: false, reason: "Could not claim the sync.", retryable: true };
  }
  if (claim === "lost") {
    // Another caller is mid-push. Report the current state rather than pushing
    // a second time; the winner will record the id.
    const { data: fresh } = await supabaseAdmin
      .from("orders")
      .select("shippo_order_id")
      .eq("order_id", orderId)
      .maybeSingle<{ shippo_order_id: string | null }>();
    return fresh?.shippo_order_id
      ? { ok: true, shippoOrderId: fresh.shippo_order_id, created: false }
      : { ok: false, reason: "A sync is already in progress.", retryable: true };
  }

  const currency = (order.currency ?? "USD").toUpperCase();
  const lineItems: ShippoOrderLineItem[] = parcel.lines.map((line) => ({
    title: line.name,
    sku: line.productId,
    quantity: line.quantity,
    total_price: money(0),
    currency,
    weight: line.unitWeightOz.toFixed(2),
    weight_unit: "oz",
  }));

  const created = await createShippoOrder({
    to_address: destinationAddress(order),
    from_address: {
      name: addresses.origin.name,
      company: addresses.origin.company || undefined,
      street1: addresses.origin.street1,
      street2: addresses.origin.street2 || undefined,
      city: addresses.origin.city,
      state: addresses.origin.state,
      zip: addresses.origin.zip,
      country: addresses.origin.country,
      phone: addresses.origin.phone || undefined,
      email: addresses.origin.email || undefined,
    },
    line_items: lineItems,
    placed_at: order.paid_at ?? new Date().toISOString(),
    // The human-readable join the owner reads in Shippo's Orders list.
    order_number: order.order_number ?? order.order_id,
    order_status: "PAID",
    shipping_cost: money(order.shipping_amount),
    shipping_cost_currency: currency,
    subtotal_price: money(order.subtotal),
    total_price: money(order.amount_paid),
    total_tax: money(order.tax_amount),
    currency,
    weight: parcel.weightOz.toFixed(2),
    weight_unit: "oz",
  });

  if (!created.ok) {
    // Release ONLY when Shippo tells us nothing was created. After a timeout the
    // order may well exist, and re-pushing would duplicate it in the Orders tab.
    if (created.safeToRetry) {
      await releaseSync(orderId, created.message);
      return { ok: false, reason: created.message, retryable: true };
    }
    await supabaseAdmin
      .from("orders")
      .update({ shippo_sync_status: "error", shippo_sync_error: created.message.slice(0, 500) })
      .eq("order_id", orderId);
    return { ok: false, reason: created.message, retryable: false };
  }

  // THE PARCEL. A Shippo Order carries line items and addresses but no parcel,
  // so an order alone opens in Shippo's dashboard with empty Length / Width /
  // Height / Weight and no rates — the operator retypes the box by hand, which
  // is precisely what this integration exists to prevent.
  //
  // Creating a Shipment bound to that order attaches the parcel we already
  // computed. Quoting is free and buys nothing, so this is safe to do
  // automatically.
  //
  // Best-effort: the order itself is already in Shippo and useful. If the
  // shipment fails, the operator can still buy a label after entering the box,
  // which is worse but not broken — so a failure here is recorded, not fatal.
  let shipmentId: string | null = null;
  const shipment = await createShipmentWithRates({
    addressFrom: toShippoAddress(addresses.origin),
    addressTo: destinationAddress(order),
    addressReturn: toShippoAddress(addresses.returnAddress),
    parcel: parcel.parcel,
    order: created.data.object_id,
  });
  if (shipment.ok) {
    shipmentId = shipment.data.shipmentId;
  } else {
    console.error("Shippo order created but the shipment failed", orderId, shipment.message);
  }

  // Record the parcel AS SENT.
  //
  // The inputs (product weights, the preset table) are all editable, so without
  // this the moment a weight is corrected there is no way to answer "what did we
  // actually declare on THAT shipment?" — which is the question that matters
  // when a carrier bills an adjustment or a parcel is refused.
  //
  // Weight is stored in parts, not just the total: a total alone cannot
  // distinguish "the vials were heavier than recorded" from "the mailer tare was
  // wrong", and those have different fixes.
  const merchandiseOz = parcel.merchandiseOz;
  const packagingOz = parcel.packagingOz;
  // An estimate is a weight nobody has put on a scale. Worth flagging, because
  // a postage figure derived from a guess should not be trusted as a margin.
  //
  // Judged on PROVENANCE -- did the SKU have a weight on file? -- and never by
  // comparing the unit weight to the catalogue default. The default is 0.36 oz
  // precisely because that is a real 3ml vial, so a correctly weighed peptide
  // and an unweighed one produce the identical number: the value carries no
  // information about where it came from. Comparing it fails in both
  // directions, flagging every ordinary peptide order as a guess while missing
  // a heavy SKU that was never weighed.
  const estimated = parcel.weightReviewRequired;

  await supabaseAdmin
    .from("orders")
    .update({
      parcel_preset_id: parcel.preset?.id ?? null,
      parcel_preset_name: parcel.preset?.name ?? null,
      parcel_length_in: parcel.preset?.lengthIn ?? null,
      parcel_width_in: parcel.preset?.widthIn ?? null,
      parcel_height_in: parcel.preset?.heightIn ?? null,
      parcel_merchandise_oz: Math.round(merchandiseOz * 100) / 100,
      parcel_packaging_oz: packagingOz,
      parcel_declared_oz: parcel.weightOz,
      parcel_weight_estimated: estimated,
      shippo_order_id: created.data.object_id,
      ...(shipmentId ? { shippo_shipment_id: shipmentId } : {}),
      shippo_sync_status: shipmentId ? "synced" : "error",
      // Named precisely: the order DID reach Shippo. Saying "sync failed" would
      // send the operator hunting for a missing order that is sitting there.
      shippo_sync_error: shipmentId
        ? null
        : `Order reached Shippo but the parcel did not: ${shipment.ok ? "" : shipment.message}`.slice(0, 500),
      shippo_synced_at: new Date().toISOString(),
    })
    .eq("order_id", orderId);

  return { ok: true, shippoOrderId: created.data.object_id, created: true };
}

// --------------------------------------------------------------- inbound ----

export interface TransactionCreatedOutcome {
  matched: boolean;
  orderId: string | null;
  reason?: string;
}

/**
 * Parse Shippo's decimal amount string into exact integer cents.
 *
 * NOT `Number(amount) * 100`: in IEEE-754 that yields 520.0000000000001 for
 * "5.20", and truncating gives 519 — a penny lost on every order, permanently
 * wrong in profit reporting and invisible without looking for it.
 */
export function amountToCents(amount: string | null | undefined): number | null {
  const raw = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const cents = `${fraction}00`.slice(0, 2);
  const value = Number(whole) * 100 + Number(cents);
  return Number.isFinite(value) ? value : null;
}

/**
 * Find the Vanta order a purchased label belongs to.
 *
 * Ordered by trustworthiness, and deliberately NOT falling back to customer
 * name or email: a repeat customer with two open orders would have a real
 * postage cost attached to whichever row was found first, corrupting profit on
 * both with nothing looking wrong.
 */
async function matchOrder(data: ShippoTransactionCreated): Promise<OrderRow | null> {
  const shippoOrderId = String(data.order ?? "").trim();
  if (shippoOrderId) {
    const { data: row } = await supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("shippo_order_id", shippoOrderId)
      .maybeSingle<OrderRow>();
    if (row) return row;
  }

  // Fallback: our order number, which we set on the Shippo order ourselves.
  // Weaker than the id — it is a string Shippo echoes rather than one it owns —
  // but still uniquely ours, unlike a customer's name.
  const metadata = String(data.metadata ?? "").trim();
  if (metadata) {
    const { data: row } = await supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("order_number", metadata)
      .maybeSingle<OrderRow>();
    if (row) return row;
  }

  return null;
}

/**
 * Apply a label purchased in Shippo's dashboard to the matching order.
 *
 * Records the exact postage, tracking, carrier and service, and reconciles the
 * cost into profit. Deliberately does NOT mark the order shipped: a label
 * exists the moment it is bought, but the parcel is still on the packing table.
 * Shipped is driven by tracking movement, and the customer's shipping email
 * follows that — never the purchase.
 */
export async function applyTransactionCreated(
  data: ShippoTransactionCreated,
): Promise<TransactionCreatedOutcome> {
  if (String(data.status ?? "").toUpperCase() !== "SUCCESS") {
    return { matched: false, orderId: null, reason: "transaction_not_successful" };
  }

  const order = await matchOrder(data);
  if (!order) {
    // Money was spent on a label we cannot attribute. Never silently dropped —
    // the webhook log keeps it for manual reconciliation.
    return { matched: false, orderId: null, reason: "no_matching_order" };
  }

  const amountCents = amountToCents(data.rate?.amount);
  const trackingNumber = String(data.tracking_number ?? "").trim() || null;
  const carrier = String(data.rate?.provider ?? "").trim() || null;
  const service = String(data.rate?.servicelevel?.name ?? "").trim() || null;
  const transactionId = String(data.object_id ?? "").trim() || null;
  const labelUrl = String(data.label_url ?? "").trim() || null;
  const now = new Date().toISOString();

  await supabaseAdmin
    .from("orders")
    .update({
      shippo_transaction_id: transactionId,
      tracking_number: trackingNumber,
      shipping_carrier: carrier,
      shipping_service: service,
      label_url: labelUrl,
      label_purchased_at: now,
      // Written only when Shippo gave a readable amount. A label with no usable
      // price must leave this NULL so the admin shows "Pending" and the owner
      // can enter it — writing 0 would silently overstate the margin instead.
      ...(amountCents !== null ? { postage_cost_cents: amountCents } : {}),
      fulfillment_status: "label_purchased",
      updated_at: now,
    })
    .eq("order_id", order.order_id);

  if (amountCents !== null) {
    await recordActualShippingCost({
      orderId: order.order_id,
      amountCents,
      source: "shippo",
    }).catch((err) => {
      console.error("Unable to reconcile shipping cost for order", order.order_id, err);
    });
  }

  await supabaseAdmin.from("order_status_history").insert({
    order_id: order.order_id,
    to_status: "label_purchased",
    source: "shippo",
    actor: "shippo_dashboard",
  });

  return { matched: true, orderId: order.order_id };
}

/**
 * Push any paid order that has not reached Shippo yet.
 *
 * This is where the automatic push lives, having been removed from the payment
 * webhook: a Shippo call can take up to 15 seconds, and awaiting that inside a
 * payment webhook delayed the response past the provider's timeout — the
 * shopper watched "Processing…" forever on an order that had actually been
 * paid. Nothing that talks to a third party belongs on that path.
 *
 * A sweep is the right home for it. It can afford to wait, it retries by
 * simply running again, and one slow order cannot hold up the others.
 *
 * Bounded per run so a large backlog cannot make the sweep itself time out —
 * the remainder is picked up on the next pass.
 */
export async function sweepUnsyncedOrders(limit = 20): Promise<{ attempted: number; synced: number; failed: number }> {
  if (!isShippoConfigured()) return { attempted: 0, synced: 0, failed: 0 };

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .eq("payment_status", "paid")
    .neq("order_type", "membership")
    .is("shippo_order_id", null)
    .order("paid_at", { ascending: true, nullsFirst: false })
    .limit(Math.min(100, Math.max(1, limit)));

  if (error || !data?.length) return { attempted: 0, synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;
  // Sequential, not parallel: twenty concurrent Shippo calls is a good way to
  // be rate-limited, and there is no deadline here worth racing.
  for (const row of data) {
    try {
      const result = await syncOrderToShippo(String(row.order_id));
      if (result.ok) synced += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: data.length, synced, failed };
}
