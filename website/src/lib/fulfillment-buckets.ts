import "server-only";

import {
  FULFILLMENT_STATUS_ORDER,
  normalizeLegacyStatus,
  type FulfillmentStatus,
} from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// THE OPERATIONAL BUCKETS.
//
// A view over the canonical pipeline, NOT a second state machine. Nothing here
// writes anything: a bucket is a question asked of `orders.fulfillment_status`
// and `orders.payment_status`, both of which remain owned by order-pipeline.ts
// and the payment webhook respectively.
//
// WHY THIS EXISTS. The fulfillment queue had three tabs — awaiting_fulfillment,
// shipped, delivered — and Shippo never writes `shipped`: TRACKING_STATUS_MAP
// maps TRANSIT to `in_transit`. So in normal, fully automatic operation an
// order VANISHED from every named queue the moment its label was bought and
// reappeared only once it was delivered. Twelve reachable states had no home:
// pending (the amount-mismatch hold), paid, ready_to_fulfill, packed,
// label_purchased, in_transit, out_for_delivery, returned, and the four legacy
// values still present on live rows.
//
// The rule this file exists to keep:
//
//   EVERY non-terminal order belongs to EXACTLY ONE bucket, or is explicitly
//   and documentedly excluded.
//
// A new canonical status added without a bucket must fail the invariant test
// that guards this file, rather than silently becoming invisible.
// ---------------------------------------------------------------------------

export type BucketId =
  | "ready"
  | "in_progress"
  | "awaiting_carrier"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exceptions"
  | "terminal";

export interface BucketDefinition {
  id: BucketId;
  label: string;
  /** One line an operator can act on. Not decoration. */
  description: string;
  /**
   * Canonical statuses in this bucket. Legacy values are normalised into these
   * by normalizeLegacyStatus BEFORE matching, so historical rows land in the
   * right place without anyone rewriting them.
   */
  statuses: readonly FulfillmentStatus[];
  /** Buckets an operator works. Ordered as the day runs. */
  operational: boolean;
}

export const BUCKETS: readonly BucketDefinition[] = [
  {
    id: "ready",
    label: "Ready to Fulfill",
    description: "Paid, eligible, and waiting to be picked.",
    // `paid` is the pipeline's own post-payment state; `ready_to_fulfill` is
    // set when an operator claims it. Both mean "nothing has happened yet".
    statuses: ["paid", "ready_to_fulfill"],
    operational: true,
  },
  {
    id: "in_progress",
    label: "In Progress",
    description: "Picked or packed, not yet labelled.",
    statuses: ["packed"],
    operational: true,
  },
  {
    id: "awaiting_carrier",
    label: "Awaiting Carrier",
    description: "Label bought. Waiting for the first carrier scan.",
    // `shipped` sits here, not in a bucket of its own: it means the owner
    // handed the parcel over but no scan has confirmed it. Operationally that
    // is the same waiting room as label_purchased.
    statuses: ["label_purchased", "shipped"],
    operational: true,
  },
  {
    id: "in_transit",
    label: "In Transit",
    description: "The carrier has it and is moving it.",
    statuses: ["in_transit"],
    operational: false,
  },
  {
    id: "out_for_delivery",
    label: "Out for Delivery",
    description: "On the van today.",
    statuses: ["out_for_delivery"],
    operational: false,
  },
  {
    id: "delivered",
    label: "Delivered",
    description: "The carrier reported delivery.",
    statuses: ["delivered"],
    operational: false,
  },
  {
    id: "exceptions",
    label: "Exceptions",
    description: "Human attention required. Work these first.",
    // `returned` is the only fulfillment STATUS that is inherently an
    // exception. The rest of this bucket comes from conditions that are not
    // fulfillment statuses at all — see EXCEPTION_REASONS.
    statuses: ["returned"],
    operational: true,
  },
  {
    id: "terminal",
    label: "Closed",
    description: "Cancelled or refunded. No further action.",
    statuses: ["cancelled", "refunded"],
    operational: false,
  },
];

/**
 * `awaiting_payment` is DELIBERATELY in no bucket.
 *
 * It is the state of an order whose money has not arrived — an abandoned
 * checkout, in most cases. Fulfillment has nothing to do until payment lands,
 * and putting thousands of dead carts into an operational queue would bury the
 * orders that matter. This is the documented exclusion the invariant allows.
 */
export const EXCLUDED_STATUSES: readonly FulfillmentStatus[] = ["awaiting_payment"];

// ---------------------------------------------------------------------------
// EXCEPTIONS THAT ARE NOT A FULFILLMENT STATUS.
//
// Every one of these is DERIVED from authoritative state that already exists.
// No new column is introduced: an exception is a question, and the answer is
// already in the row. Persisting it would create a second source of truth that
// could disagree with the condition it describes.
// ---------------------------------------------------------------------------
export type ExceptionReason =
  | "payment_hold"
  | "payment_review"
  | "shippo_error"
  | "shippo_blocked"
  | "returned"
  | "label_claim_stranded"
  | "carrier_never_scanned"
  | "transit_stalled";

/**
 * STALENESS THRESHOLDS — BUSINESS CONFIGURATION, NOT PHYSICS.
 *
 * Every other exception answers "is this state wrong?". These two answer a
 * harder question: "has nothing happened for too long?" A parcel that gets a
 * label and is never scanned sits in Awaiting Carrier looking perfectly normal
 * forever, because no status is wrong — the carrier simply never took it. That
 * is the failure a store only notices when the customer asks.
 *
 * The numbers below are starting points chosen to be quiet rather than noisy,
 * and the owner should move them once real carrier behaviour is known:
 *
 *   36h — a label bought Friday evening and collected Monday morning is normal.
 *         Anything past a day and a half means the parcel is probably still on
 *         the bench, or the carrier missed the pickup.
 *   10d — domestic ground rarely exceeds a week. Ten days without a single new
 *         scan usually means the parcel is genuinely lost, not slow.
 *
 * They are NOT thresholds the software derived; nothing in the data implies
 * them. Treat them as settings that happen to live in code today.
 */
export const CARRIER_ACCEPTANCE_STALE_HOURS = 36;
export const TRANSIT_STALE_DAYS = 10;

export interface ExceptionDefinition {
  reason: ExceptionReason;
  label: string;
  /** What the operator is supposed to do about it. */
  action: string;
  /** Where the condition is written, so the derivation can be audited. */
  derivedFrom: string;
}

export const EXCEPTION_REASONS: readonly ExceptionDefinition[] = [
  {
    reason: "payment_hold",
    label: "Payment amount mismatch",
    action: "Compare the charge against the order total before releasing it.",
    // payment-webhook.ts marks the order paid, raises a CRITICAL alert, and
    // deliberately leaves fulfillment_status at the pre-payment value so it
    // cannot ship. Correct — but it appeared in no queue at all.
    derivedFrom: "payment_status = 'paid' AND fulfillment_status IN ('pending','awaiting_payment')",
  },
  {
    reason: "payment_review",
    label: "Awaiting payment verification",
    action: "Verify the off-platform payment, then approve or reject it.",
    derivedFrom: "payment_status = 'awaiting_verification'",
  },
  {
    reason: "shippo_error",
    label: "Shippo sync failed",
    action: "Shippo rejected this order. The reason is shown below — fix it, then retry the sync.",
    derivedFrom: "shippo_sync_status = 'error'",
  },
  {
    reason: "shippo_blocked",
    label: "Blocked before Shippo",
    action: "Vanta stopped before sending this to Shippo — usually the ship-from address or the parcel setup.",
    derivedFrom: "shippo_sync_status = 'blocked'",
  },
  {
    reason: "returned",
    label: "Parcel returned",
    action: "Decide between reship and refund.",
    derivedFrom: "fulfillment_status = 'returned'",
  },
  {
    reason: "label_claim_stranded",
    label: "Label purchase never completed",
    action: "A label purchase started and never confirmed. Postage may have been charged \u2014 check Shippo before buying again.",
    derivedFrom: "label_purchase_claimed_at IS NOT NULL AND shippo_transaction_id IS NULL",
  },
  {
    reason: "carrier_never_scanned",
    label: "Label bought, carrier never scanned it",
    action:
      `No acceptance scan in ${CARRIER_ACCEPTANCE_STALE_HOURS} hours. The parcel is probably still on the bench, ` +
      "or the carrier missed the pickup — check the shelf before telling the customer it is on its way.",
    derivedFrom:
      `fulfillment_status = 'label_purchased' AND label_purchased_at older than ${CARRIER_ACCEPTANCE_STALE_HOURS}h`,
  },
  {
    reason: "transit_stalled",
    label: "In transit, but not moving",
    action:
      `No carrier update in ${TRANSIT_STALE_DAYS} days. Open a trace with the carrier, and decide whether to reship.`,
    derivedFrom: `fulfillment_status IN ('in_transit','out_for_delivery') AND last movement older than ${TRANSIT_STALE_DAYS}d`,
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const STATUS_TO_BUCKET = new Map<FulfillmentStatus, BucketId>();
for (const bucket of BUCKETS) {
  for (const status of bucket.statuses) {
    STATUS_TO_BUCKET.set(status, bucket.id);
  }
}

/**
 * Which bucket a raw database value belongs to, legacy values included.
 * Returns null for an excluded status, and undefined for one nothing knows
 * about — the invariant test treats those differently, because the first is a
 * decision and the second is a bug.
 */
export function bucketForStatus(raw: string | null | undefined): BucketId | null | undefined {
  const status = normalizeLegacyStatus(raw);
  if (!status) return undefined;
  if (EXCLUDED_STATUSES.includes(status)) return null;
  return STATUS_TO_BUCKET.get(status);
}

/** Every canonical status, for the invariant test to enumerate. */
export const ALL_CANONICAL_STATUSES: readonly FulfillmentStatus[] = FULFILLMENT_STATUS_ORDER;

export function bucketById(id: BucketId): BucketDefinition | undefined {
  return BUCKETS.find((b) => b.id === id);
}

// ---------------------------------------------------------------------------
// THE ROW, NOT THE STATUS.
//
// bucketForStatus() is not enough on its own, and the reason is worth stating
// because it is exactly the defect this file exists to close.
//
// LEGACY_STATUS_MAP normalises the raw value `pending` to `paid`. Two very
// different orders carry that raw value:
//
//   * an order at creation           — payment_status = 'pending_payment'
//   * an order HELD by the amount-mismatch check — payment_status = 'paid',
//     because payment-webhook.ts marks it paid, raises a CRITICAL alert, and
//     parks fulfillment_status at 'pending' so it cannot ship.
//
// The second normalises to `paid`, which sits in READY. So classifying by
// status alone would have put a held order — the one case a human must look at
// before anything leaves the building — straight into the pick queue.
//
// Exceptions are therefore evaluated FIRST, from the whole row, and an order in
// an exception is in NO other bucket.
// ---------------------------------------------------------------------------

/** The columns a bucket decision reads. All authoritative, none new. */
export interface OrderBucketInput {
  payment_status: string | null | undefined;
  fulfillment_status: string | null | undefined;
  shippo_sync_status?: string | null;
  label_purchase_claimed_at?: string | null;
  shippo_transaction_id?: string | null;
  /** When postage was bought — the clock for carrier_never_scanned. */
  label_purchased_at?: string | null;
  /** Last carrier movement — the clock for transit_stalled. */
  updated_at?: string | null;
  shipped_at?: string | null;
}

/**
 * Hours since an ISO timestamp, or null when it is absent or unparseable.
 *
 * Returns null rather than 0 for a missing timestamp on purpose: "we do not
 * know when this happened" must never read as "it happened just now", or an
 * order with no timestamp would look permanently fresh and never age into an
 * exception.
 */
function hoursSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (now - then) / 3_600_000;
}

/** Raw fulfillment values that mean "has not entered fulfillment yet". */
const PRE_FULFILLMENT_RAW = new Set(["pending", "pending_payment", "unpaid", "awaiting_payment"]);

/**
 * Every exception this order is in, most urgent first. Empty means none.
 * Derived entirely from existing columns — no exception is ever persisted.
 */
export function exceptionsForOrder(order: OrderBucketInput, nowMs: number = Date.now()): ExceptionReason[] {
  const payment = String(order.payment_status ?? "").toLowerCase();
  const rawFulfillment = String(order.fulfillment_status ?? "").toLowerCase();
  const sync = String(order.shippo_sync_status ?? "").toLowerCase();
  const found: ExceptionReason[] = [];

  // The hold. Paid, but parked before fulfillment by the amount-mismatch check.
  if (payment === "paid" && PRE_FULFILLMENT_RAW.has(rawFulfillment)) found.push("payment_hold");
  if (payment === "awaiting_verification") found.push("payment_review");
  if (sync === "error") found.push("shippo_error");
  if (sync === "blocked") found.push("shippo_blocked");
  if (normalizeLegacyStatus(rawFulfillment) === "returned") found.push("returned");
  if (order.label_purchase_claimed_at && !order.shippo_transaction_id) found.push("label_claim_stranded");

  // THE TWO SILENCES. Everything above asks whether a state is wrong; these ask
  // whether nothing has happened for too long. A parcel with a label the carrier
  // never scanned, and a parcel that stopped moving, are both invisible without
  // them — no status is incorrect, so no other rule fires.
  const canonical = normalizeLegacyStatus(rawFulfillment);

  if (canonical === "label_purchased") {
    const waiting = hoursSince(order.label_purchased_at, nowMs);
    if (waiting !== null && waiting >= CARRIER_ACCEPTANCE_STALE_HOURS) found.push("carrier_never_scanned");
  }

  if (canonical === "in_transit" || canonical === "out_for_delivery") {
    // updated_at moves on every accepted carrier event, so it IS the last
    // movement. shipped_at is the fallback for a row that predates that.
    const idle = hoursSince(order.updated_at ?? order.shipped_at, nowMs);
    if (idle !== null && idle >= TRANSIT_STALE_DAYS * 24) found.push("transit_stalled");
  }

  return found;
}

/**
 * The single bucket this order belongs to, or null if it is documentedly
 * excluded from operational queues.
 */
export function bucketForOrder(order: OrderBucketInput, nowMs: number = Date.now()): BucketId | null | undefined {
  if (exceptionsForOrder(order, nowMs).length > 0) return "exceptions";
  return bucketForStatus(order.fulfillment_status);
}
