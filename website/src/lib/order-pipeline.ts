// The single source of truth for where an order is in the shipping lifecycle.
//
// Vanta Labs fulfils every order in-house, so an order's fulfillment_status is
// written from three very different places: the payment webhook (money landed),
// the admin UI (a human packed a box and bought a label), and Shippo's tracking
// webhook (the carrier scanned the parcel). Those three writers race, retry, and
// - in Shippo's case - arrive OUT OF ORDER. Without one shared rulebook a late
// TRANSIT scan silently un-delivers a delivered order, and a customer gets an
// "on the way" email for a parcel already on their porch.
//
// Everything here is PURE: no database, no network, no clock. Callers hand in
// the current status and the proposed one and get back a decision they can act
// on. Nothing in this module ever throws - a malformed webhook body must produce
// a rejection the route can answer 200 to, not a 500 that makes Shippo retry the
// same bad event forever.

import type { ShippoTrackingStatus } from "@/lib/shippo/types";

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export type FulfillmentStatus =
  | "awaiting_payment"
  | "paid"
  | "ready_to_fulfill"
  | "packed"
  | "label_purchased"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "refunded"
  | "returned";

/**
 * The nine statuses a healthy order walks through, in order. Used for the
 * "never go backwards" check on carrier scans, so the sequence here is a
 * behavioural contract, not just a display preference.
 */
const PIPELINE_PROGRESSION: readonly FulfillmentStatus[] = [
  "awaiting_payment",
  "paid",
  "ready_to_fulfill",
  "packed",
  "label_purchased",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivered",
];

/**
 * Statuses that end the order somewhere other than a delivered parcel. They sit
 * OFF the progression ladder on purpose: "returned" is not further along than
 * "delivered", it is a different outcome, and ranking them against each other
 * would let a rank comparison approve nonsense.
 */
const EXCEPTION_STATUSES: readonly FulfillmentStatus[] = ["cancelled", "refunded", "returned"];

/** Canonical ordering for dropdowns, filters and sorting. */
export const FULFILLMENT_STATUS_ORDER: readonly FulfillmentStatus[] = [
  ...PIPELINE_PROGRESSION,
  ...EXCEPTION_STATUSES,
];

export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  ready_to_fulfill: "Ready to fulfill",
  packed: "Packed",
  label_purchased: "Label purchased",
  shipped: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  returned: "Returned",
};

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return typeof value === "string" && (FULFILLMENT_STATUS_ORDER as readonly string[]).includes(value);
}

/**
 * How far along the shipping ladder a status is, or null for the exception
 * statuses which are deliberately unranked. Only ever compare two non-null
 * ranks - a null means "this outcome is not on the ladder", never "rank zero".
 */
export function progressRank(status: FulfillmentStatus): number | null {
  const index = PIPELINE_PROGRESSION.indexOf(status);
  return index === -1 ? null : index;
}

/**
 * The parcel's journey is over: no carrier scan may move the order again.
 *
 * This is what stops an out-of-order webhook from un-delivering an order. It is
 * NOT "no field may ever change again" - a human can still record a refund or a
 * physical return on top of a delivered order, which is why the transition table
 * below still has outgoing edges for some terminal statuses.
 */
export function isTerminal(status: FulfillmentStatus): boolean {
  return status === "delivered" || status === "cancelled" || status === "refunded" || status === "returned";
}

// ---------------------------------------------------------------------------
// Legacy values
// ---------------------------------------------------------------------------

/**
 * Rows written before this pipeline existed (and rows still written today by
 * the payment webhook, replacements and quote orders) hold their own vocabulary.
 * They are mapped, never rewritten in place: a migration that rewrote historical
 * statuses would destroy the only record of what those orders actually did, and
 * a CHECK constraint on the column would reject them outright.
 *
 * Note this maps ONE axis. `pending` is written both at order creation and while
 * a payment is held, so anything that needs to know whether money actually
 * arrived must read payment_status - this mapping never claims to answer that.
 */
const LEGACY_STATUS_MAP: Record<string, FulfillmentStatus> = {
  // Pre-payment.
  awaiting_payment: "awaiting_payment",
  pending_payment: "awaiting_payment",
  unpaid: "awaiting_payment",

  // Paid, not yet queued.
  pending: "paid",
  paid: "paid",

  // In the packing queue. `sent_to_fulfillment` is a fossil of the removed 3PL:
  // the order was handed off but nothing shipped, so it belongs back in the
  // owner's own queue rather than being treated as in-flight.
  awaiting_fulfillment: "ready_to_fulfill",
  processing: "ready_to_fulfill",
  ready_to_fulfill: "ready_to_fulfill",
  sent_to_fulfillment: "ready_to_fulfill",

  packed: "packed",
  label_purchased: "label_purchased",

  // `fulfilled` / `partially_fulfilled` meant "it left the building" - the
  // closest honest modern status is shipped. Membership orders also carry
  // `fulfilled`; they are digital and never enter the shipping queue at all.
  fulfilled: "shipped",
  partially_fulfilled: "shipped",
  shipped: "shipped",

  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",

  cancelled: "cancelled",
  // US spelling, from payment-types.ts.
  canceled: "cancelled",
  refunded: "refunded",
  returned: "returned",
};

/**
 * Normalise a raw database value to a pipeline status.
 *
 * Returns null for anything unrecognised rather than guessing. Guessing is how
 * an unpaid order ends up looking ready to ship; a null forces the caller to
 * decide what an unknown value means in its own context.
 */
export function normalizeLegacyStatus(value: string | null | undefined): FulfillmentStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  // Hyphens and spaces show up in hand-typed admin values and CSV imports.
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) {
    return null;
  }
  return LEGACY_STATUS_MAP[key] ?? null;
}

/**
 * Display text for any stored value, legacy or current. Falls back to a
 * title-cased version of the raw value so an unrecognised status still renders
 * as readable text instead of an empty cell that looks like missing data.
 */
export function fulfillmentStatusLabel(value: string | null | undefined): string {
  const normalized = normalizeLegacyStatus(value);
  if (normalized) {
    return FULFILLMENT_STATUS_LABELS[normalized];
  }
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "Unknown";
  }
  return raw.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Who is allowed to do what
// ---------------------------------------------------------------------------

/**
 * Which subsystem is asking. Stored verbatim in order_status_history.source.
 *
 * - "admin"  a human clicked something in the dashboard
 * - "shippo" a carrier scan arrived on the tracking webhook
 * - "system" our own server code (payment webhook, label purchase, label void)
 */
export type TransitionSource = "admin" | "shippo" | "system";

/**
 * The sources permitted to move an order INTO each status.
 *
 * The important line is the carrier-only block: in_transit, out_for_delivery and
 * delivered are physical facts about a parcel, and the only party that observes
 * them is the carrier. Letting an admin click "Delivered" would put a claim in
 * the record - and a delivery-confirmation email in the customer's inbox - that
 * nothing can back up. An order shipped without a Shippo label therefore ends at
 * "shipped" and stays there, which is deliberate: no tracking, no delivery claim.
 */
export const FULFILLMENT_STATUS_SOURCES: Record<FulfillmentStatus, readonly TransitionSource[]> = {
  // Set when the order is created; a human never picks it.
  awaiting_payment: ["system"],
  // Money state belongs to the payment webhook, never to a dashboard dropdown.
  paid: ["system"],
  ready_to_fulfill: ["admin", "system"],
  // "system" appears here because voiding a label walks the order back to packed.
  packed: ["admin", "system"],
  // Written by the label-purchase code after Shippo returns SUCCESS; "shippo"
  // because a PRE_TRANSIT scan can also be the first thing that tells us a label
  // exists. "admin" so a manually-entered label can be recorded.
  label_purchased: ["admin", "system", "shippo"],
  // The owner physically hands the parcel over, so a human marks this.
  shipped: ["admin", "system"],
  in_transit: ["shippo"],
  out_for_delivery: ["shippo"],
  delivered: ["shippo"],
  cancelled: ["admin", "system"],
  refunded: ["admin", "system"],
  // Tracking reports RETURNED/FAILURE; an admin can also record a parcel that
  // physically came back without a scan ever firing.
  returned: ["shippo", "admin"],
};

/**
 * Every legal edge. Absence is a rejection - there is no implicit "any forward
 * move is fine", because forward moves like paid -> shipped skip the steps that
 * buy the label and record its cost.
 */
export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  awaiting_payment: ["paid", "cancelled"],
  paid: ["ready_to_fulfill", "cancelled", "refunded"],
  // shipped is reachable directly: an owner who drops a parcel off without
  // ticking "packed" should not be blocked by a bookkeeping step.
  ready_to_fulfill: ["packed", "label_purchased", "shipped", "cancelled", "refunded"],
  packed: ["ready_to_fulfill", "label_purchased", "shipped", "cancelled", "refunded"],
  // packed is the void-a-label destination. The carrier states are all reachable
  // because scans can start before the owner gets round to marking it shipped.
  label_purchased: [
    "packed",
    "shipped",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "returned",
    "cancelled",
    "refunded",
  ],
  // No cancel after shipping: the goods are gone, so the honest outcomes are a
  // refund or a return, both of which reverse the money properly.
  shipped: ["in_transit", "out_for_delivery", "delivered", "returned", "refunded"],
  in_transit: ["out_for_delivery", "delivered", "returned", "refunded"],
  // Deliberately no route back to in_transit. A failed delivery attempt does
  // re-report TRANSIT, but so does a webhook that arrived late, and we cannot
  // tell them apart from the payload - so the pipeline never walks backwards.
  out_for_delivery: ["delivered", "returned", "refunded"],
  // A delivered parcel can still be sent back or refunded by a human.
  delivered: ["returned", "refunded"],
  cancelled: ["refunded"],
  // The accounting end state. A parcel drifting home afterwards does not change
  // the fact that the money was returned, so nothing follows it.
  refunded: [],
  returned: ["refunded"],
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionRejectionReason =
  /** `from` or `to` is not a status this pipeline knows. */
  | "unknown_status"
  /** Already there. Not an error - just nothing to write. */
  | "unchanged"
  /** The parcel's journey is finished and this source may not restart it. */
  | "terminal"
  /** A carrier scan that would move the order backwards (out-of-order webhook). */
  | "regression"
  /** This source is not allowed to set that status. */
  | "source_not_permitted"
  /** No edge exists between these two statuses. */
  | "not_allowed";

export interface TransitionRejection {
  ok: false;
  reason: TransitionRejectionReason;
  /** Admin-facing explanation; safe to surface in an API error body. */
  message: string;
  from: FulfillmentStatus | null;
  to: FulfillmentStatus | null;
}

export type TransitionResult = { ok: true; from: FulfillmentStatus; next: FulfillmentStatus } | TransitionRejection;

function reject(
  reason: TransitionRejectionReason,
  message: string,
  from: FulfillmentStatus | null,
  to: FulfillmentStatus | null,
): TransitionRejection {
  return { ok: false, reason, message, from, to };
}

/**
 * Decide whether an order may move from one status to another.
 *
 * `from` and `to` are accepted as raw strings because both arrive untrusted -
 * `from` straight off a database row that may hold a legacy value, `to` from an
 * admin form or a webhook body. Both are normalised here so no caller has to
 * remember to do it.
 *
 * Check order matters: terminal protection is evaluated before the edge table so
 * a late carrier scan on a delivered order reports "terminal" (the real reason)
 * rather than a generic "not allowed".
 */
export function canTransition(
  from: string | null | undefined,
  to: string | null | undefined,
  source: TransitionSource = "system",
): TransitionResult {
  const current = normalizeLegacyStatus(from);
  const next = normalizeLegacyStatus(to);

  if (!current) {
    return reject("unknown_status", `Unrecognised current status "${String(from ?? "")}".`, null, next);
  }
  if (!next) {
    return reject("unknown_status", `Unrecognised target status "${String(to ?? "")}".`, current, null);
  }

  if (current === next) {
    return reject(
      "unchanged",
      `Order is already ${FULFILLMENT_STATUS_LABELS[current].toLowerCase()}.`,
      current,
      next,
    );
  }

  const permitted = FULFILLMENT_STATUS_SOURCES[next];
  if (!permitted.includes(source)) {
    return reject(
      "source_not_permitted",
      `${FULFILLMENT_STATUS_LABELS[next]} can only be set by ${permitted.join(" or ")}, not ${source}.`,
      current,
      next,
    );
  }

  if (source === "shippo") {
    if (isTerminal(current)) {
      return reject(
        "terminal",
        `Tracking update ignored: order is already ${FULFILLMENT_STATUS_LABELS[current].toLowerCase()}.`,
        current,
        next,
      );
    }

    // Shippo replays and reorders deliveries, so an event that would move the
    // order backwards is by definition stale - the newer state already won.
    const currentRank = progressRank(current);
    const nextRank = progressRank(next);
    if (currentRank !== null && nextRank !== null && nextRank < currentRank) {
      return reject(
        "regression",
        `Stale tracking update: ${FULFILLMENT_STATUS_LABELS[next].toLowerCase()} arrived after ${FULFILLMENT_STATUS_LABELS[current].toLowerCase()}.`,
        current,
        next,
      );
    }
  }

  if (!FULFILLMENT_TRANSITIONS[current].includes(next)) {
    return reject(
      "not_allowed",
      `Cannot move an order from ${FULFILLMENT_STATUS_LABELS[current].toLowerCase()} to ${FULFILLMENT_STATUS_LABELS[next].toLowerCase()}.`,
      current,
      next,
    );
  }

  return { ok: true, from: current, next };
}

/** The statuses this source may move the order to right now - for admin buttons. */
export function allowedTransitions(
  from: string | null | undefined,
  source: TransitionSource = "system",
): FulfillmentStatus[] {
  return FULFILLMENT_STATUS_ORDER.filter((status) => canTransition(from, status, source).ok);
}

/** A ready-to-insert order_status_history row. */
export interface OrderStatusHistoryRecord {
  order_id: string;
  from_status: FulfillmentStatus | null;
  to_status: FulfillmentStatus;
  source: TransitionSource;
  actor: string | null;
}

export interface TransitionRequest {
  orderId: string;
  /** The order's stored fulfillment_status, legacy values included. */
  from: string | null | undefined;
  to: string | null | undefined;
  source: TransitionSource;
  /** WHO, for the audit trail: an admin username, a carrier name, a cron job. */
  actor?: string | null;
}

export type AppliedTransition =
  | { ok: true; from: FulfillmentStatus; next: FulfillmentStatus; history: OrderStatusHistoryRecord }
  | TransitionRejection;

/**
 * Validate a transition and build the audit row that goes with it.
 *
 * The history row stores the NORMALISED from-status, not the raw legacy value,
 * so the timeline can be queried with one vocabulary. The raw value is still
 * where it always was - on the order row until this write lands.
 */
export function applyTransition(request: TransitionRequest): AppliedTransition {
  const result = canTransition(request.from, request.to, request.source);
  if (!result.ok) {
    return result;
  }

  const actor = typeof request.actor === "string" && request.actor.trim() ? request.actor.trim() : null;

  return {
    ok: true,
    from: result.from,
    next: result.next,
    history: {
      order_id: String(request.orderId ?? ""),
      from_status: result.from,
      to_status: result.next,
      source: request.source,
      actor,
    },
  };
}

// ---------------------------------------------------------------------------
// Shippo tracking
// ---------------------------------------------------------------------------

/**
 * Carrier scan -> pipeline status.
 *
 * UNKNOWN and PRE_TRANSIT both mean "a label exists, the carrier has not got the
 * parcel yet", which is exactly label_purchased. FAILURE is folded into returned
 * because every failure Shippo reports this way (undeliverable, refused, damaged)
 * ends with the parcel coming back to us - it is an exception to work, not a
 * separate status the storefront needs to render.
 */
const TRACKING_STATUS_MAP: Record<ShippoTrackingStatus, FulfillmentStatus> = {
  UNKNOWN: "label_purchased",
  PRE_TRANSIT: "label_purchased",
  TRANSIT: "in_transit",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
  RETURNED: "returned",
  FAILURE: "returned",
};

/**
 * Returns null for anything Shippo has not documented. An unknown scan state
 * must be dropped, not coerced onto the nearest status - webhook bodies are
 * untrusted input, and a wrong guess here writes a lie into the order.
 */
export function mapShippoTrackingStatus(status: string | null | undefined): FulfillmentStatus | null {
  if (typeof status !== "string") {
    return null;
  }
  const key = status.trim().toUpperCase();
  return TRACKING_STATUS_MAP[key as ShippoTrackingStatus] ?? null;
}

/**
 * The whole tracking-webhook decision in one call: map the carrier's scan, then
 * run it through the same rules as everything else with source "shippo" (so
 * terminal protection and the no-regression rule both apply).
 */
export function applyTrackingUpdate(input: {
  orderId: string;
  from: string | null | undefined;
  trackingStatus: string | null | undefined;
  actor?: string | null;
}): AppliedTransition {
  const next = mapShippoTrackingStatus(input.trackingStatus);
  if (!next) {
    return reject(
      "unknown_status",
      `Unrecognised Shippo tracking status "${String(input.trackingStatus ?? "")}".`,
      normalizeLegacyStatus(input.from),
      null,
    );
  }
  return applyTransition({
    orderId: input.orderId,
    from: input.from,
    to: next,
    source: "shippo",
    actor: input.actor ?? "shippo",
  });
}
