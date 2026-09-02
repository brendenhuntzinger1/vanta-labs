import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getShippingAddresses } from "@/lib/shipping-origin";
import { recordActualShippingCost } from "@/lib/admin-profit";
import {
  createShipmentWithRates,
  createShippoOrder,
  getTransaction,
  settledCentsForTransaction,
} from "@/lib/shippo/client";
import { isShippoConfigured } from "@/lib/shippo/config";
import { buildOrderParcel, toCountryCode } from "@/lib/shippo/service";
import type { ShippoAddress, ShippoOrderLineItem, ShippoTransactionCreated } from "@/lib/shippo/types";
import { canTransition } from "@/lib/order-pipeline";
import { recordSystemAlert } from "@/lib/monitoring";

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
  fulfillment_status: string | null;
  order_number: string | null;
  customer_name: string | null;
  phone: string | null;
  shipping_address: string | null;
  shipping_address_2: string | null;
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
  /**
   * Read so a label adopted from the dashboard can be told apart from a replay
   * of the event for the label that was voided — see applyTransactionCreated.
   */
  shippo_transaction_id: string | null;
  label_voided_at: string | null;
  /**
   * When the label currently on this row was recorded. The ordering key for
   * "is this incoming transaction_created newer than what we already hold?".
   */
  label_purchased_at: string | null;
}

const ORDER_COLUMNS =
  // fulfillment_status is selected so the monotonicity guard in
// applyTransactionCreated can read the order's CURRENT progress before
// deciding whether a late label event is allowed to move it.
  "order_id, order_number, customer_name, phone, shipping_address, shipping_address_2, city, state, postal_code, country, subtotal, shipping_amount, tax_amount, amount_paid, currency, paid_at, payment_status, fulfillment_status, order_type, shippo_order_id, shippo_transaction_id, label_voided_at, label_purchased_at";

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

/**
 * THE SHOPPER'S EMAIL ADDRESS IS NOT SENT.
 *
 * It used to be, and that is how a customer came to receive a UPS "Your
 * package is on the way!" email headed "From BRENDEN HUNTZINGER" — the owner's
 * own name, from a carrier, about an order placed with Vanta Labs.
 *
 * This store sends its own shipping and delivery emails. notifyCustomer() in
 * service.ts composes them from the store's templates, on the store's domain,
 * with a tracking link resolved through the carrier allow-list, and fires each
 * one exactly once per order. A carrier email arriving alongside them is a
 * second, unbranded voice talking to the customer, saying whatever the label
 * and the carrier account happen to say, and nothing here can edit a word of
 * it.
 *
 * An address a carrier does not have is one it cannot mail. That is the whole
 * mechanism, and it is why this is an omission rather than a setting: a
 * notification preference in a dashboard is one support call from being
 * switched back on by somebody who does not know this decision was made.
 *
 * NOTHING IS LOST ON THE FULFILMENT SIDE. This address goes onto the Shippo
 * ORDER, which is a record for the owner to buy a label against; the shipment
 * that actually carries a parcel is built by orderDestinationAddress() in
 * service.ts, which has never sent an email address either. Rates, labels and
 * tracking are unaffected. The one real cost is that the shopper's email no
 * longer appears beside the order in Shippo's dashboard — it is in the admin,
 * on the order, where support already looks.
 *
 * THIS DOES NOT SILENCE EVERY CARRIER EMAIL, and it cannot. A recipient
 * enrolled in UPS My Choice (or a carrier equivalent) is notified about
 * parcels addressed to them from their own account, on a subscription this
 * store is not party to and cannot cancel. What that email SAYS is set by the
 * label's shipper name, which is configured wherever the label is bought.
 */
function destinationAddress(order: OrderRow): ShippoAddress {
  return {
    name: order.customer_name ?? "",
    street1: order.shipping_address ?? "",
    // Omitted rather than sent blank when there is no unit: Shippo treats an
    // empty string as a validation failure, not as "no second line".
    street2: order.shipping_address_2?.trim() || undefined,
    city: order.city ?? "",
    state: order.state ?? "",
    zip: order.postal_code ?? "",
    country: toCountryCode(order.country),
    phone: order.phone ?? undefined,
  };
}

/**
 * HOW LONG A SYNC CLAIM IS BELIEVED.
 *
 * The claim is a LEASE, not a tombstone. It was written as a tombstone: taken
 * before the push and cleared on exactly one path (a Shippo failure that is
 * demonstrably safe to retry), so a run that simply STOPPED — the 60s function
 * limit, a redeploy mid-request, a container reaped — left the column set with
 * nothing anywhere that would ever clear it. That order then matched
 * sweepUnsyncedOrders' window for ever (it selects on `shippo_order_id is
 * null`), was picked up every thirty minutes, lost the claim every time, and
 * occupied one of the twenty slots per tick while newer paid orders queued
 * behind it. One stranded order is a paid parcel that never reaches Shippo;
 * twenty of them is the sweep doing nothing at all.
 *
 * Thirty minutes: far longer than any run can live (maxDuration is 60s and a
 * Shippo call gives up at 15s), so a lease this old cannot belong to a process
 * that is still working.
 */
const SYNC_CLAIM_TTL_MS = 30 * 60 * 1000;

/** One reclaim notice per order per day, not one per sweep tick. */
const STALE_CLAIM_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;

/**
 * Take over a lease whose owner is gone.
 *
 * Only reached when the ordinary claim lost, and deliberately narrow — three
 * conditions have to hold before a second push is allowed to happen:
 *
 *  • `shippo_order_id` is still null. If a push finished, there is nothing to
 *    retry and re-pushing is exactly the duplicate this claim exists to prevent.
 *  • The lease is older than SYNC_CLAIM_TTL_MS, so no live run owns it.
 *  • `shippo_sync_status` is not 'error'. THIS IS THE DELIBERATE HOLD. When
 *    Shippo answers in a way that means "the order may exist but I cannot tell
 *    you" (a 5xx, a timeout — `safeToRetry: false`), syncOrderToShippo keeps the
 *    claim on purpose and stamps 'error'. That combination — a held claim with
 *    no Shippo id and an error status — is only ever written by that one branch,
 *    because the other writer of 'error' with no id (releaseSync) clears the
 *    claim in the same statement. Reclaiming it would re-push an order Shippo
 *    might already hold. A human clears that one, from the admin retry button,
 *    which is the confirmation that it is not in Shippo.
 *
 * The retake is a compare-and-swap on the lease being STILL EXPIRED, so two
 * sweeps racing to reclaim the same dead lease cannot both win it: the winner's
 * write moves the timestamp to now, and `lt(cutoff)` then excludes the row for
 * everyone else.
 *
 * WHY THE SWAP IS A RANGE AND NOT AN EQUALITY. The obvious compare-and-swap is
 * `eq(shippo_sync_claimed_at, <the value just read>)`. It does not work, and it
 * fails SILENTLY, which is worse: the timestamp goes out over the wire as JSON
 * and comes back rounded. Postgres holds `22:20:11.710961+00`; the value this
 * code receives is `22:20:11.710Z`. Comparing that back for equality matches
 * nothing, so the reclaim quietly never fires and the TTL is decoration. Caught
 * against a real Postgres — no in-memory double can show it, because the double
 * hands back the string it was given.
 *
 * `lt` is immune: a lease half an hour old is not going to be misjudged by a
 * fraction of a millisecond.
 */
async function reclaimStaleSync(orderId: string, nowMs: number): Promise<"won" | "lost" | "error"> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("shippo_order_id, shippo_sync_claimed_at, shippo_sync_status")
    .eq("order_id", orderId)
    .maybeSingle<{
      shippo_order_id: string | null;
      shippo_sync_claimed_at: string | null;
      shippo_sync_status: string | null;
    }>();

  if (error) return "error";
  if (!data || data.shippo_order_id) return "lost";

  const claimedAt = data.shippo_sync_claimed_at ? Date.parse(data.shippo_sync_claimed_at) : Number.NaN;
  if (!Number.isFinite(claimedAt) || nowMs - claimedAt < SYNC_CLAIM_TTL_MS) return "lost";
  // The deliberate hold, checked HERE rather than as an `or(...)` group on the
  // update. PostgREST expresses "status is null OR status <> 'error'" as a
  // nested boolean group, and a layer that does not implement it drops the
  // filter without complaining — which would reclaim exactly the hold this
  // guard exists to protect. A guard that can silently evaporate is not a
  // guard. Nothing can turn this row into a deliberate hold between the read
  // and the write: doing so requires holding the claim, and the claim is dead.
  if (String(data.shippo_sync_status ?? "").toLowerCase() === "error") return "lost";

  const staleBefore = new Date(nowMs - SYNC_CLAIM_TTL_MS).toISOString();
  const { data: retaken, error: retakeError } = await supabaseAdmin
    .from("orders")
    .update({ shippo_sync_claimed_at: new Date(nowMs).toISOString() })
    .eq("order_id", orderId)
    // Compare-and-swap: only a caller that still sees an EXPIRED lease wins it.
    .lt("shippo_sync_claimed_at", staleBefore)
    .is("shippo_order_id", null)
    .select("id");

  if (retakeError) return "error";
  if (!retaken || retaken.length === 0) return "lost";

  // Visible, not silent. A lease that had to be reclaimed means a run died
  // holding it, and the operator should be able to see that happening rather
  // than only its symptom weeks later. Deduped per day so a persistently
  // crashing sync reports a condition rather than a stream.
  await recordSystemAlert({
    type: "shippo_sync_claim_reclaimed",
    severity: "warning",
    message:
      "A Shippo sync claim was still held long after any run could have been using it, so it was released and the "
      + "order re-queued. This means an earlier sync stopped mid-push (a function timeout or a redeploy).",
    context: { orderId, claimedAt: data.shippo_sync_claimed_at, ttlMinutes: SYNC_CLAIM_TTL_MS / 60_000 },
    dedupeWindowMs: STALE_CLAIM_ALERT_DEDUPE_MS,
  }).catch(() => {
    // Never let the alert be what stops the repair it is reporting on.
  });

  return "won";
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
 *
 * Losing that update no longer ends the story: see reclaimStaleSync for the
 * one case where a lost claim is a dead lease rather than a live competitor.
 */
async function claimSync(orderId: string): Promise<"won" | "lost" | "error"> {
  const nowMs = Date.now();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ shippo_sync_claimed_at: new Date(nowMs).toISOString() })
    .eq("order_id", orderId)
    .is("shippo_sync_claimed_at", null)
    .select("id");
  if (error) {
    console.error("Shippo sync claim failed for order", orderId, error);
    // Fail closed: an unknown claim state must never read as "go ahead".
    return "error";
  }
  if (data && data.length > 0) return "won";

  return reclaimStaleSync(orderId, nowMs);
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

  // These two checks run BEFORE anything is claimed or sent, and both used to
  // return without writing a word. So a store with, say, no ship-from ZIP would
  // have every push fail silently every thirty minutes, forever, while the order
  // showed a blank sync status and a blank error -- indistinguishable from an
  // order nothing had tried yet. The failure that repeats is the one that most
  // needs a reason attached.
  const recordBlocked = async (reason: string) => {
    await supabaseAdmin
      .from("orders")
      .update({ shippo_sync_status: "blocked", shippo_sync_error: reason.slice(0, 500) })
      .eq("order_id", orderId)
      .is("shippo_order_id", null);
  };

  const addresses = await getShippingAddresses();
  if (!addresses.canRequestRates) {
    // Two possible reasons now — an unusable ship-from address, or a missing
    // customer-facing return address. Naming the wrong one sends the owner to
    // fix a field that was already correct.
    const reason = `${addresses.blockedReason ?? "Shipping addresses are not configured."} Set it in admin → Settings.`;
    await recordBlocked(reason);
    return { ok: false, reason, retryable: true };
  }

  const parcelResult = await buildOrderParcel(orderId);
  if (!parcelResult.ok) {
    await recordBlocked(parcelResult.message);
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

export interface LabelFacts {
  amountCents: number | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
}

/**
 * The facts about a bought label, read from either shape Shippo sends.
 *
 * `rate` arrives expanded on some responses and as a bare object_id string on
 * others. Reading `.amount` off the string form yields undefined, which is how
 * three real orders ended up marked "label purchased" with no recorded cost and
 * a profit line permanently stuck on ESTIMATED. One reader, both shapes, so a
 * caller cannot accidentally handle only the convenient one.
 */
export function labelFactsFrom(source: {
  tracking_number?: string | null;
  label_url?: string | null;
  rate?: string | { amount?: string | null; provider?: string | null; servicelevel?: { name?: string | null } | null } | null;
}): LabelFacts {
  const text = (value: unknown) => String(value ?? "").trim() || null;
  // A string rate is an ID, not a price. It carries no cost information at all.
  const rate = source.rate && typeof source.rate === "object" ? source.rate : null;
  return {
    amountCents: amountToCents(rate?.amount),
    carrier: text(rate?.provider),
    service: text(rate?.servicelevel?.name),
    trackingNumber: text(source.tracking_number),
    labelUrl: text(source.label_url),
  };
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
  // A READ THAT FAILED IS NOT A LABEL THAT BELONGS TO NOBODY. Discarding these
  // errors turned a transient failure into "no_matching_order", which raises a
  // CRITICAL shippo_label_unattributed alert naming a cause that is not the
  // cause — and answers 200, so Shippo never redelivers the event and the real
  // postage is lost. Throwing releases the route's event claim and lets the
  // redelivery find the order.
  const shippoOrderId = String(data.order ?? "").trim();
  if (shippoOrderId) {
    const { data: row, error } = await supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("shippo_order_id", shippoOrderId)
      .maybeSingle<OrderRow>();
    if (error) throw error;
    if (row) return row;
  }

  // Fallback: our order number, which we set on the Shippo order ourselves.
  // Weaker than the id — it is a string Shippo echoes rather than one it owns —
  // but still uniquely ours, unlike a customer's name.
  const metadata = String(data.metadata ?? "").trim();
  if (metadata) {
    // Tries BOTH columns, because the field carries the order NUMBER now and
    // historical transactions carry the internal id. Matching only one meant
    // this fallback silently resolved nothing for every label Vanta had
    // purchased — the writer sent one format and the reader looked up the
    // other.
    for (const column of ["order_number", "order_id"] as const) {
      const { data: row, error } = await supabaseAdmin
        .from("orders")
        .select(ORDER_COLUMNS)
        .eq(column, metadata)
        .maybeSingle<OrderRow>();
      if (error) throw error;
      if (row) return row;
    }
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
/**
 * IS THIS EVENT ABOUT A NEWER LABEL THAN THE ONE THE ORDER ALREADY HOLDS?
 *
 * Shippo replays AND REORDERS deliveries, and the route-level event_key dedupe
 * only blocks a redelivery of the transaction currently on the row. Every other
 * stale shape was wide open, because "different transaction id" was read as
 * "this is a replacement label":
 *
 *   t0  T1 bought          -> transaction T1, postage 742 recorded
 *   t1  T1 voided in-app   -> label_voided_at set, cost nulled
 *   t2  T2 bought          -> transaction T2, void cleared, postage 1200
 *   t3  T1's transaction_created finally arrives (never seen, so not deduped)
 *
 * At t3, T1 !== T2, so the VOIDED label was classified as the replacement: the
 * void was cleared, the order was pointed back at the dead transaction, the
 * voided label's tracking number and printable label_url were restored onto a
 * live order, and recordActualShippingCost overwrote a CORRECT 1200 with the
 * refunded 742 while profit_finalized stayed true.
 *
 * The rule is monotonic: label facts only ever move forward.
 *
 * COMPARE LIKE WITH LIKE, OR THE GUARD REFUSES LIVE LABELS.
 *
 * This used to weigh Shippo's `object_created` for the INCOMING transaction
 * against `orders.label_purchased_at` — and label_purchased_at is written as
 * RECEIPT time (`now`), here and in service.ts, not as the transaction's
 * creation time. Two clocks, and Shippo replays late, so the local one runs
 * ahead of the remote one by however long a delivery was delayed:
 *
 *   t0     T1 bought in the dashboard
 *   t0+3m  T2 bought in the dashboard (the real replacement)
 *   t0+10m T1's transaction_created finally arrives -> label_purchased_at = t0+10m
 *   t0+11m T2's event arrives: object_created (t0+3m) < label_purchased_at (t0+10m)
 *
 * The LIVE label was refused as stale, the order kept the dead transaction, T2's
 * postage was never recorded, and the only trace was a `warning` with no email.
 *
 * So both sides of the comparison now come from Shippo: the incoming
 * transaction's `object_created` against the RECORDED transaction's
 * `object_created`, read back with a GET (which cannot buy anything). Only when
 * one of those two creation times cannot be established at all does it fall
 * back to the incoming transaction's live status — and that fallback is
 * deliberately weak, so anything other than SUCCESS is refused and the row is
 * left alone, which is the direction that cannot destroy a correct value.
 */
async function isNewerThanRecordedLabel(
  data: ShippoTransactionCreated,
  transactionId: string,
  order: OrderRow,
): Promise<boolean> {
  const recordedId = order.shippo_transaction_id ? String(order.shippo_transaction_id) : null;

  // The incoming transaction's creation time, from the delivery if it carries
  // one and from Shippo itself if it does not — a thin replay is not evidence
  // about ordering, and the previous code let one through on status alone.
  let incomingCreated = Date.parse(String(data.object_created ?? ""));
  let incomingStatus = String(data.status ?? "").toUpperCase();
  if (!Number.isFinite(incomingCreated)) {
    const fetchedIncoming = await getTransaction(transactionId);
    if (!fetchedIncoming.ok) return false;
    incomingCreated = Date.parse(String(fetchedIncoming.data.object_created ?? ""));
    incomingStatus = String(fetchedIncoming.data.status ?? "").toUpperCase();
  }

  if (Number.isFinite(incomingCreated) && recordedId) {
    const fetchedRecorded = await getTransaction(recordedId);
    if (fetchedRecorded.ok) {
      const recordedCreated = Date.parse(String(fetchedRecorded.data.object_created ?? ""));
      if (Number.isFinite(recordedCreated)) return incomingCreated >= recordedCreated;
      // A recorded transaction Shippo reports as REFUNDED or ERROR is not a
      // label this order should be costed on, whatever its timestamps say.
      const recordedStatus = String(fetchedRecorded.data.status ?? "").toUpperCase();
      if (recordedStatus && recordedStatus !== "SUCCESS") return true;
    }
  }

  if (incomingStatus) return incomingStatus === "SUCCESS";

  const fetched = await getTransaction(transactionId);
  if (!fetched.ok) return false;
  return String(fetched.data.status ?? "").toUpperCase() === "SUCCESS";
}

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

  const transactionId = String(data.object_id ?? "").trim() || null;

  // REFUSE A LABEL EVENT THAT WOULD MOVE THIS ORDER BACKWARDS.
  //
  // Only a delivery naming a DIFFERENT transaction from the one on the row can
  // do that; a redelivery of the same transaction is already handled (and is
  // what the route's event_key dedupe blocks anyway).
  const recordedTransactionId = order.shippo_transaction_id
    ? String(order.shippo_transaction_id)
    : null;
  if (
    transactionId
    && recordedTransactionId
    && transactionId !== recordedTransactionId
    && !(await isNewerThanRecordedLabel(data, transactionId, order))
  ) {
    // Never silent: a refused label event is money Shippo believes was spent.
    await recordSystemAlert({
      type: "shippo_stale_transaction_ignored",
      severity: "warning",
      message:
        `A Shippo transaction_created for order ${order.order_id} named transaction ${transactionId}, which is `
        + `not newer than the label already recorded (${recordedTransactionId}). It was ignored rather than `
        + "allowed to overwrite the live label's tracking, cost and voided state.",
      context: {
        orderId: order.order_id,
        incomingTransactionId: transactionId,
        recordedTransactionId,
        incomingCreatedAt: data.object_created ?? null,
        recordedLabelPurchasedAt: order.label_purchased_at ?? null,
      },
    }).catch(() => {});
    return { matched: true, orderId: order.order_id, reason: "stale_transaction" };
  }

  // WHAT THE LABEL COST, FROM WHICHEVER SHAPE ARRIVED.
  //
  // Shippo sends `rate` expanded on some responses and as a bare object_id
  // string on others. This read only ever handled the expanded form, so a label
  // bought in Shippo's dashboard produced amount/provider/servicelevel all
  // undefined — while the status move in the same UPDATE succeeded. The order
  // showed "label purchased" with "Actual shipping: Pending label purchase" and
  // an ESTIMATED profit that could never finalise.
  //
  // When the webhook is thin, ask Shippo for the transaction itself. That is
  // the authoritative record of what was actually spent, and it is the only way
  // to recover a cost the webhook never carried.
  let facts = labelFactsFrom(data);
  if (transactionId && (facts.amountCents === null || !facts.carrier || !facts.trackingNumber)) {
    const fetched = await getTransaction(transactionId);
    if (fetched.ok) {
      const expanded = labelFactsFrom(fetched.data);
      // Prefer anything the webhook already gave us; fill only the gaps.
      facts = {
        amountCents: facts.amountCents ?? expanded.amountCents,
        carrier: facts.carrier ?? expanded.carrier,
        service: facts.service ?? expanded.service,
        trackingNumber: facts.trackingNumber ?? expanded.trackingNumber,
        labelUrl: facts.labelUrl ?? expanded.labelUrl,
      };
      // A DASHBOARD LABEL PRICES ITS RATE BY REFERENCE. The transaction Shippo
      // returns for a label bought in its dashboard carries `rate` as a bare
      // object_id, so labelFactsFrom — which can only read an expanded rate —
      // still leaves the cost NULL here. That is precisely the owner's normal
      // workflow, so it left every dashboard label with no postage recorded,
      // profit stuck on the flat estimate, and a manual-entry alert repeating
      // until somebody typed the figure in by hand. The reference is readable:
      // one GET on the rate, only when nothing else answered.
      if (facts.amountCents === null) {
        facts = { ...facts, amountCents: await settledCentsForTransaction(fetched.data) };
      }
    } else {
      // Not fatal: the status move and whatever the webhook did carry are still
      // worth writing. The cost stays NULL, which is what makes the admin show
      // "Pending" rather than a wrong number.
      console.error("Unable to read the Shippo transaction for cost recovery", transactionId, fetched.message);
    }
  }

  const { amountCents, carrier, service, trackingNumber, labelUrl } = facts;
  const now = new Date().toISOString();

  // THE STATUS MOVE IS SEPARATE FROM THE LABEL FACTS, AND ONLY THE MOVE IS
  // GUARDED.
  //
  // Shippo replays and reorders deliveries. This used to write
  // fulfillment_status = "label_purchased" unconditionally, so a
  // `transaction_created` arriving after the parcel had already been scanned in
  // transit — or delivered — rewrote the later state with an earlier one and
  // lost the parcel's real progress. Confirmed by reproduction before this
  // change: delivered, in_transit and out_for_delivery all regressed.
  //
  // canTransition already encodes exactly the right rule for source "shippo":
  // it refuses a move whose progressRank is lower than the current status, and
  // refuses any move out of a terminal one. Routing through it keeps ONE
  // monotonicity rule in the codebase instead of a second, private copy — and
  // it leaves Shippo's authority over legitimate shipping transitions intact,
  // because `label_purchased` still lists "shippo" as a permitted source.
  //
  // The label METADATA is written either way, deliberately. A tracking number,
  // a carrier and a postage cost are facts about a shipment that stay true
  // whenever they arrive; only the STATUS is a claim about progress. Dropping
  // the metadata on a late event would lose the real cost of a real label.
  const transition = canTransition(order.fulfillment_status, "label_purchased", "shippo");

  // The label metadata is a fact and is written either way (see above). The
  // STATUS is a decision made against order.fulfillment_status, read moments
  // ago — so it is applied only while the row still holds that value. Without
  // that guard a concurrent carrier scan could be overwritten by this stale
  // label_purchased decision, regressing an order the pipeline had already
  // moved on. Same shape as service.applyTrackingUpdate.
  // A NEW TRANSACTION IS A NEW LABEL, AND A NEW LABEL IS NOT VOIDED.
  //
  // The in-app re-buy path clears label_voided_at (purchaseLabelForOrder); this
  // one did not. So an admin who voided a label in-app and then bought the
  // replacement in the Shippo DASHBOARD ended up with a live label on a row
  // still marked voided — which recordActualShippingCost refuses to cost and
  // the repair sweep filters out. Real postage, never charged to profit, no
  // error anywhere.
  //
  // ONLY FOR A DIFFERENT TRANSACTION. A redelivery of the event for the label
  // that WAS voided carries the same object_id, and un-voiding on that would
  // resurrect exactly the refunded-postage re-charge the void protection
  // exists to stop.
  const isReplacementLabel = Boolean(transactionId) && transactionId !== order.shippo_transaction_id;
  const labelFacts = {
      // Written only when the delivery actually names one. This was
      // unconditional, so a thin transaction_created with no object_id BLANKED
      // a recorded transaction id — leaving a label_purchased_at row with no
      // transaction, which nothing can ever repair and which the shipping sweep
      // could not even see.
      ...(transactionId !== null ? { shippo_transaction_id: transactionId } : {}),
      ...(isReplacementLabel ? { label_voided_at: null } : {}),
      // Each written only when we actually have it. These used to be
      // unconditional, so a second, thinner delivery of the same event — or a
      // replay Shippo sent without the expanded rate — overwrote a good
      // tracking number and carrier with null. A fact we already hold is never
      // worth less than the absence of one.
      ...(trackingNumber !== null ? { tracking_number: trackingNumber } : {}),
      ...(carrier !== null ? { shipping_carrier: carrier } : {}),
      ...(service !== null ? { shipping_service: service } : {}),
      ...(labelUrl !== null ? { label_url: labelUrl } : {}),
      label_purchased_at: now,
      // Written only when Shippo gave a readable amount. A label with no usable
      // price must leave this NULL so the admin shows "Pending" and the owner
      // can enter it — writing 0 would silently overstate the margin instead.
      ...(amountCents !== null ? { postage_cost_cents: amountCents } : {}),
      updated_at: now,
  };

  let statusApplied = false;

  if (transition.ok) {
    const guarded = supabaseAdmin
      .from("orders")
      .update({ ...labelFacts, fulfillment_status: "label_purchased" })
      .eq("order_id", order.order_id);
    const { data: touched, error: guardError } =
      order.fulfillment_status === null || order.fulfillment_status === undefined
        ? await guarded.is("fulfillment_status", null).select("order_id")
        : await guarded.eq("fulfillment_status", order.fulfillment_status).select("order_id");

    statusApplied = !guardError && Array.isArray(touched) && touched.length > 0;

    if (!statusApplied) {
      // Lost the race, or the write failed. Either way the status is not ours
      // to set — but the label facts still are, and postage has been spent.
      await supabaseAdmin.from("orders").update(labelFacts).eq("order_id", order.order_id);
    }
  } else {
    await supabaseAdmin.from("orders").update(labelFacts).eq("order_id", order.order_id);
  }

  if (amountCents !== null) {
    // THE RETURN VALUE IS THE FAILURE, NOT AN EXCEPTION. recordActualShippingCost
    // reports a refusal as { ok: false } and does not throw, so a `.catch()`
    // alone discarded every one of them: postage spent, profit still on the
    // flat estimate, nothing logged and nothing alerted. The repair sweep picks
    // up a live label on its next tick, so this is a warning rather than a
    // page — but it is durable and it names the order.
    const recorded = await recordActualShippingCost({
      orderId: order.order_id,
      amountCents,
      source: "shippo",
    }).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));

    if (!recorded.ok) {
      console.error("Unable to reconcile shipping cost for order", order.order_id, recorded.error);
      await recordSystemAlert({
        type: "shipping_cost_unrecorded",
        severity: "warning",
        message:
          `A Shippo label for order ${order.order_id} cost ${amountCents} cents, but that cost could not be `
          + "recorded, so this order's profit is still on the flat shipping estimate.",
        context: { orderId: order.order_id, transactionId, amountCents, reason: recorded.error ?? null },
      }).catch(() => {});
    }
  }

  // History records what actually happened. A refused transition did not move
  // the order, so writing a row for it would put a state change in the
  // customer-facing timeline that never occurred. A duplicate delivery of the
  // same event is refused as "unchanged" and is silent here for the same reason.
  if (transition.ok && statusApplied) {
    await supabaseAdmin.from("order_status_history").insert({
      order_id: order.order_id,
      from_status: transition.from,
      to_status: "label_purchased",
      source: "shippo",
      actor: "shippo_dashboard",
    });
  }

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
/**
 * Attach the parcel to an order that already reached Shippo without one.
 *
 * A Shippo Order and its Shipment are created in two calls, and only the first
 * is fatal if it fails. So an order can land in the Orders tab with no parcel --
 * blank dimensions, blank weight, no rates -- and every automatic path then
 * skips it forever, because all three key off shippo_order_id being NULL:
 * syncOrderToShippo short-circuits, the sweep filters it out, and the admin
 * retry button reports "already synced". The one state that needs repair was
 * the one state nothing retried.
 *
 * Creating a Shipment costs nothing, so this is safe to run automatically. It
 * binds to the EXISTING Shippo order rather than making a second one.
 */
export async function backfillOrderShipment(orderId: string): Promise<SyncOutcome> {
  if (!isShippoConfigured()) {
    return { ok: false, reason: "Shippo is not configured.", retryable: true };
  }

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select(`${ORDER_COLUMNS}, shippo_shipment_id`)
    .eq("order_id", orderId)
    .maybeSingle<OrderRow & { shippo_shipment_id: string | null }>();

  if (error || !order) return { ok: false, reason: "Order not found.", retryable: false };
  if (!order.shippo_order_id) {
    return { ok: false, reason: "This order has not reached Shippo yet.", retryable: false };
  }
  if (order.shippo_shipment_id) {
    return { ok: true, shippoOrderId: order.shippo_order_id, created: false };
  }

  const addresses = await getShippingAddresses();
  if (!addresses.canRequestRates) {
    return {
      ok: false,
      reason: addresses.blockedReason ?? "Shipping addresses are not configured.",
      retryable: true,
    };
  }

  const parcelResult = await buildOrderParcel(orderId);
  if (!parcelResult.ok) return { ok: false, reason: parcelResult.message, retryable: true };
  const parcel = parcelResult.data;

  const shipment = await createShipmentWithRates({
    addressFrom: toShippoAddress(addresses.origin),
    addressTo: destinationAddress(order),
    addressReturn: toShippoAddress(addresses.returnAddress),
    parcel: parcel.parcel,
    order: order.shippo_order_id,
  });

  if (!shipment.ok) {
    // 404 means the stored Shippo order does not exist ON THIS ACCOUNT. The
    // usual cause is a credential change: Shippo's test and live environments
    // hold entirely separate objects, so swapping a test token for a live one
    // orphans every id written before the swap. The order is real, it is simply
    // in an environment these credentials cannot see -- and it will never
    // appear in the live dashboard.
    //
    // Forgetting the id is what lets the ordinary push run again and put the
    // order into the account that is actually connected now. Safe from
    // duplicates precisely BECAUSE Shippo answered 404: there is nothing here
    // to duplicate. Any other error leaves the id alone, since an order that
    // might exist must never be pushed twice.
    if (shipment.status === 404) {
      await supabaseAdmin
        .from("orders")
        .update({
          shippo_order_id: null,
          shippo_shipment_id: null,
          shippo_sync_claimed_at: null,
          shippo_sync_status: "error",
          shippo_sync_error:
            "The stored Shippo order does not exist on the connected account (usually a test/live credential change). It has been queued to be pushed again.",
        })
        .eq("order_id", orderId)
        .eq("shippo_order_id", order.shippo_order_id);
      return {
        ok: false,
        reason: "Stored Shippo order not found on this account; queued for a fresh push.",
        retryable: true,
      };
    }

    await supabaseAdmin
      .from("orders")
      .update({
        shippo_sync_status: "error",
        shippo_sync_error: `Order is in Shippo but the parcel is not: ${shipment.message}`.slice(0, 500),
      })
      .eq("order_id", orderId);
    return { ok: false, reason: shipment.message, retryable: true };
  }

  // Guarded on the column still being empty. Two concurrent repairs (the sweep
  // and the admin button) would each create a Shipment; the first write wins and
  // the loser's is left unreferenced in Shippo. That costs nothing and is far
  // better than a lock that can strand the row permanently if a run dies.
  await supabaseAdmin
    .from("orders")
    .update({
      parcel_preset_id: parcel.preset?.id ?? null,
      parcel_preset_name: parcel.preset?.name ?? null,
      parcel_length_in: parcel.preset?.lengthIn ?? null,
      parcel_width_in: parcel.preset?.widthIn ?? null,
      parcel_height_in: parcel.preset?.heightIn ?? null,
      parcel_merchandise_oz: Math.round(parcel.merchandiseOz * 100) / 100,
      parcel_packaging_oz: parcel.packagingOz,
      parcel_declared_oz: parcel.weightOz,
      parcel_weight_estimated: parcel.weightReviewRequired,
      shippo_shipment_id: shipment.data.shipmentId,
      shippo_sync_status: "synced",
      shippo_sync_error: null,
      shippo_synced_at: new Date().toISOString(),
    })
    .eq("order_id", orderId)
    .is("shippo_shipment_id", null);

  return { ok: true, shippoOrderId: order.shippo_order_id, created: true };
}

/**
 * Repair every order sitting in Shippo without a parcel.
 *
 * Skips anything already labelled: once postage is bought the parcel is settled,
 * and adding a shipment afterwards would only clutter the account.
 */
export async function sweepMissingShipments(limit = 20): Promise<{ attempted: number; repaired: number; failed: number }> {
  if (!isShippoConfigured()) return { attempted: 0, repaired: 0, failed: 0 };

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .eq("payment_status", "paid")
    .neq("order_type", "membership")
    .not("shippo_order_id", "is", null)
    .is("shippo_shipment_id", null)
    .is("shippo_transaction_id", null)
    .order("paid_at", { ascending: true, nullsFirst: false })
    .limit(Math.min(100, Math.max(1, limit)));

  if (error || !data?.length) return { attempted: 0, repaired: 0, failed: 0 };

  let repaired = 0;
  let failed = 0;
  for (const row of data) {
    try {
      const result = await backfillOrderShipment(String(row.order_id));
      if (result.ok) repaired += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: data.length, repaired, failed };
}

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
