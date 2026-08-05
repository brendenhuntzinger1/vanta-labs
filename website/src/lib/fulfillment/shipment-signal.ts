// -------------------------------------------------------------------------
// What a 3PL status actually MEANS about the package.
//
// A shipping label being created is not a shipment. The label is bought and
// printed while the box is still on the packing bench — often hours or days
// before a carrier takes possession. A customer who gets "Your order has
// shipped" at that moment then watches tracking sit motionless, and writes in
// asking where their package is.
//
// So the confirmation email is gated on MOVEMENT, never on paperwork:
//
//   pre_transit  label exists, carrier has not taken it → no email
//   shipped      carrier has it / it is moving          → shipping email
//   delivered    it arrived                              → delivery email
//
// Providers name these states inconsistently, and some report a label purchase
// with `status: "shipped"` outright. Two defences:
//
//  1. A broad pre-transit vocabulary, so label states are recognised as label
//     states whatever they are called.
//  2. A LABEL EVENT CAN NEVER PRODUCE A SHIPPED SIGNAL. If the event itself is
//     about a label, the package has not moved, regardless of the status string
//     riding along with it. That single rule is what makes the requirement hold
//     even against a provider that calls a label purchase a shipment.
//
// Pure and provider-agnostic: a new provider's vocabulary is added to a list
// here, never to the email-sending path.
// -------------------------------------------------------------------------

export type ShipmentSignal = "pre_transit" | "shipped" | "delivered" | "cancelled" | "none";

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// A label was bought/printed, or the parcel is waiting for the carrier. Real
// paperwork, no movement.
const PRE_TRANSIT_STATUSES = new Set([
  "label_created",
  "label_printed",
  "label_purchased",
  "label_generated",
  "labeled",
  "labelled",
  "ready_to_ship",
  "ready_for_pickup",
  "awaiting_pickup",
  "awaiting_collection",
  "pending_pickup",
  "pickup_scheduled",
  "manifest",
  "manifested",
  "pre_transit",
  "pretransit",
  "information_received",
  "shipment_created",
  "shipment_information_sent_to_fedex",
  "unshipped",
]);

// The carrier has the package, or it is on its way.
const SHIPPED_STATUSES = new Set([
  "shipped",
  "in_transit",
  "intransit",
  "transit",
  "accepted",
  "picked_up",
  "pickup",
  "collected",
  "dispatched",
  "departed",
  "out_for_delivery",
  "on_the_way",
  "en_route",
]);

const DELIVERED_STATUSES = new Set(["delivered", "fulfilled", "completed", "arrived"]);

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "voided", "label_voided", "returned"]);

/**
 * True when the event is about a shipping label rather than the package
 * moving. Such an event must never be allowed to read as "shipped".
 */
export function isLabelEvent(eventType: string | null | undefined): boolean {
  const normalized = normalize(eventType);
  if (!normalized) return false;
  // "label_voided" is a cancellation, handled separately — it is still not a
  // shipment, so treating it as label-ish here is harmless and correct.
  return normalized.includes("label") || normalized.includes("manifest") || normalized.includes("pre_transit");
}

/**
 * Classify a provider's status (plus the event type it arrived on) into what it
 * says about the package.
 *
 * `eventType` is the webhook's own `type`/`event` field. When it identifies a
 * label event, a "shipped"-looking status is demoted to pre-transit — paperwork
 * cannot be movement.
 */
export function classifyShipmentStatus(
  status: string | null | undefined,
  eventType?: string | null,
): ShipmentSignal {
  const normalizedStatus = normalize(status);
  const labelEvent = isLabelEvent(eventType);

  if (CANCELLED_STATUSES.has(normalizedStatus)) return "cancelled";
  if (DELIVERED_STATUSES.has(normalizedStatus)) return "delivered";
  if (PRE_TRANSIT_STATUSES.has(normalizedStatus)) return "pre_transit";

  if (SHIPPED_STATUSES.has(normalizedStatus)) {
    // The rule that makes this safe against a provider which reports a label
    // purchase as a shipment.
    return labelEvent ? "pre_transit" : "shipped";
  }

  // An unrecognised status on a label event is still a label event.
  if (labelEvent) return "pre_transit";
  return "none";
}

/** The `orders.fulfillment_status` a signal should put the order into. */
export function fulfillmentStatusForSignal(signal: ShipmentSignal): string | null {
  switch (signal) {
    // Deliberately NOT a "shipped"-family status: the customer timeline should
    // read "Being prepared" while a label exists but nothing has moved.
    case "pre_transit":
      return "awaiting_fulfillment";
    case "shipped":
      return "shipped";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** Whether a transition into this signal should email the customer. */
export function signalNotifiesCustomer(signal: ShipmentSignal): boolean {
  return signal === "shipped" || signal === "delivered";
}

/**
 * How far along an `orders.fulfillment_status` is, for enforcing that shipment
 * progress only moves forward. Unknown/cancelled statuses rank 0 so they never
 * block a real transition.
 */
export function fulfillmentProgressRank(status: string | null | undefined): number {
  switch (normalize(status)) {
    case "pending":
    case "processing":
    case "awaiting_fulfillment":
    case "partially_fulfilled":
      return 1;
    case "shipped":
    case "out_for_delivery":
      return 2;
    case "delivered":
    case "fulfilled":
      return 3;
    default:
      return 0;
  }
}
