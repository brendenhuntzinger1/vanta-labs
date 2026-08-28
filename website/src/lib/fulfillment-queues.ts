import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import {
  BUCKETS,
  EXCEPTION_REASONS,
  bucketForOrder,
  exceptionsForOrder,
  type BucketId,
  type ExceptionReason,
  type OrderBucketInput,
} from "@/lib/fulfillment-buckets";
import { fulfillmentStatusLabel, normalizeLegacyStatus } from "@/lib/order-pipeline";
import { readAllRowsBounded } from "@/lib/supabase-page";

// ---------------------------------------------------------------------------
// THE OPERATIONAL QUEUES.
//
// Read-only over `orders`. Nothing in this file writes a fulfillment status,
// and nothing derives one: the bucket is computed by fulfillment-buckets.ts
// from columns the payment webhook and order-pipeline.ts already own.
//
// WHY THE QUERIES LOOK REPETITIVE. Each bucket is fetched with a SEPARATE
// single-status equality, then merged, rather than one `.in(...)` covering the
// bucket's statuses. That is not style — it was measured on a 50,555-row clone:
//
//   single-status equality       0.075 ms   ordered index scan, 25 rows read
//   = ANY([4 statuses])          4.04  ms   bitmap scan, ordering discarded,
//                                           5,658 rows read and sorted
//
// With (payment_status, fulfillment_status, paid_at) the equality columns come
// first and paid_at is already ordered WITHIN each status, so Postgres can walk
// the index and stop at the page size. An IN list spans several index ranges,
// so it falls back to a bitmap and has to sort. Fifty times slower, for a query
// that runs on every admin page load.
// ---------------------------------------------------------------------------

/** The columns every queue row needs. Deliberately narrow — no SELECT *. */
const QUEUE_COLUMNS =
  "order_id, order_number, customer_name, customer_email, city, state, country, "
  + "payment_status, fulfillment_status, shippo_sync_status, shippo_sync_error, "
  + "tracking_number, shipping_carrier, label_url, shippo_transaction_id, "
  + "label_purchase_claimed_at, paid_at, created_at, "
  // The clocks for the two time-based exceptions. Without these selected, a
  // parcel the carrier never scanned and a parcel that stopped moving both
  // stay invisible — the rules exist but never see a timestamp to measure.
  + "label_purchased_at, shipped_at, updated_at, priority";

export interface QueueOrder {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  destination: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  /** The pipeline's own words for the status, not the raw column value. */
  fulfillmentLabel: string;
  bucket: BucketId | null | undefined;
  exceptions: ExceptionReason[];
  trackingNumber: string | null;
  carrier: string | null;
  /** True when a Shippo label was bought for this order. */
  hasLabel: boolean;
  /**
   * Shippo's own words for why a sync failed, surfaced so the operator reads
   * the error instead of being told to go and look up a column.
   */
  shippoSyncError: string | null;
  paidAt: string | null;
  createdAt: string;
  batchId: string | null;
  /**
   * Expedited. The column existed and shipped nowhere: with four priority
   * orders sitting in a 60-order pick queue, nothing on the workstation
   * distinguished them from the other fifty-six.
   */
  priority: boolean;
}

function toQueueOrder(row: Record<string, unknown>, batchId: string | null = null): QueueOrder {
  const input: OrderBucketInput = {
    payment_status: String(row.payment_status ?? ""),
    fulfillment_status: String(row.fulfillment_status ?? ""),
    shippo_sync_status: row.shippo_sync_status ? String(row.shippo_sync_status) : null,
    label_purchase_claimed_at: row.label_purchase_claimed_at ? String(row.label_purchase_claimed_at) : null,
    shippo_transaction_id: row.shippo_transaction_id ? String(row.shippo_transaction_id) : null,
    // The staleness clocks.
    label_purchased_at: row.label_purchased_at ? String(row.label_purchased_at) : null,
    shipped_at: row.shipped_at ? String(row.shipped_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
  const place = [row.city, row.state, row.country].filter(Boolean).join(", ");
  return {
    orderId: String(row.order_id),
    orderNumber: row.order_number ? String(row.order_number) : null,
    customerName: row.customer_name ? String(row.customer_name) : null,
    destination: place,
    paymentStatus: input.payment_status ?? "",
    fulfillmentStatus: input.fulfillment_status ?? "",
    fulfillmentLabel: fulfillmentStatusLabel(input.fulfillment_status),
    bucket: bucketForOrder(input),
    exceptions: exceptionsForOrder(input),
    trackingNumber: row.tracking_number ? String(row.tracking_number) : null,
    carrier: row.shipping_carrier ? String(row.shipping_carrier) : null,
    hasLabel: Boolean(row.shippo_transaction_id || row.label_url),
    shippoSyncError: row.shippo_sync_error ? String(row.shippo_sync_error) : null,
    paidAt: row.paid_at ? String(row.paid_at) : null,
    createdAt: String(row.created_at),
    batchId,
    priority: row.priority === true || row.priority === "true",
  };
}

// Every query below is scoped to PHYSICAL, PAID orders: membership orders are
// digital and never ship, and unpaid orders are abandoned carts. Both would
// bury the orders that actually need work.

/** Every raw status that maps into a bucket, so a query can ask for it. */
function rawStatusesForBucket(bucket: BucketId): string[] {
  const definition = BUCKETS.find((b) => b.id === bucket);
  if (!definition) return [];
  // Both the canonical value AND the legacy values that normalise onto it, so
  // historical rows appear without anyone rewriting them.
  const LEGACY_BY_CANONICAL: Record<string, string[]> = {
    paid: ["paid", "pending"],
    ready_to_fulfill: ["ready_to_fulfill", "awaiting_fulfillment", "processing", "sent_to_fulfillment"],
    shipped: ["shipped", "fulfilled", "partially_fulfilled"],
    cancelled: ["cancelled", "canceled"],
  };
  return definition.statuses.flatMap((s) => LEGACY_BY_CANONICAL[s] ?? [s]);
}

export interface BucketCount {
  id: BucketId;
  label: string;
  description: string;
  operational: boolean;
  count: number;
}

export interface BucketBoard {
  counts: BucketCount[];
  /**
   * True when the scan ceiling stopped the read before every order had been
   * bucketed, so every count below is a FLOOR. A board that is quietly short is
   * a board that says there is less to do than there is.
   */
  truncated: boolean;
}

/**
 * The columns a bucket decision reads.
 *
 * THE LAST THREE ARE CLOCKS, AND THEY WERE MISSING.
 *
 * Six of the eight exception rules read a status; two read a TIMESTAMP —
 * carrier_never_scanned (label bought, never scanned) and transit_stalled
 * (moving, then stopped). exceptionsForOrder measures both against
 * label_purchased_at / updated_at / shipped_at, and a column that was never
 * selected reaches it as `undefined`, which hoursSince answers `null` to. So
 * both rules evaluated to "not stale" on every row, forever.
 *
 * Nothing errored and nothing looked wrong: the parcel the carrier never
 * collected was simply counted under "Awaiting Carrier" — a normal, waiting,
 * nobody-do-anything state — on the nav badge and on the dashboard headline
 * that answers "what needs a human". The queue that RENDERS those orders reads
 * the wider QUEUE_COLUMNS and got it right, so the board and its own queue
 * disagreed.
 *
 * Kept as one list next to QUEUE_COLUMNS so the count and the queue cannot
 * drift apart again.
 */
const BUCKET_DECISION_COLUMNS =
  "order_id, payment_status, fulfillment_status, shippo_sync_status, "
  + "label_purchase_claimed_at, shippo_transaction_id, "
  + "label_purchased_at, shipped_at, updated_at";

// Ceiling on one board, not a definition of the answer — see `truncated`.
// Matched to the reporting modules (admin-profit, admin-tax-report,
// admin-reconciliation) so no surface has a lower ceiling than another.
const MAX_BUCKET_ORDERS = 200_000;

/** Exactly the shape BUCKET_DECISION_COLUMNS selects. */
type BucketDecisionRow = OrderBucketInput & { order_id: string };

/**
 * How many orders sit in each bucket right now.
 *
 * PAGED. This select carried no `.limit()` and no `.range()`, which is not the
 * same as being unbounded: PostgREST caps every response at `db-max-rows`
 * (Supabase ships 1000) and does it SILENTLY — a valid array that simply stops.
 * Past that many paid orders the entire board was computed from the first page
 * and presented as the state of the store, so an operator with 1,500 orders
 * waiting was told 1,000. Paging to exhaustion removes the dependency on a
 * setting this application cannot see, and `truncated` says so when the
 * ceiling — not the data — ended the read.
 */
export async function getBucketCounts(): Promise<BucketBoard> {
  const { rows, truncated } = await readAllRowsBounded<BucketDecisionRow>(
    (from, to) =>
      supabaseAdmin
        .from("orders")
        .select(BUCKET_DECISION_COLUMNS)
        .neq("order_type", "membership")
        .in("payment_status", ["paid", "awaiting_verification"])
        // order_id is unique, so paging on it can neither repeat nor skip a row.
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: BucketDecisionRow[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_BUCKET_ORDERS, label: "bucket counts read" },
  );

  const tally = new Map<BucketId, number>();
  for (const row of rows) {
    const bucket = bucketForOrder(row);
    if (!bucket) continue;
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
  }

  return {
    counts: BUCKETS.map((b) => ({
      id: b.id,
      label: b.label,
      description: b.description,
      operational: b.operational,
      count: tally.get(b.id) ?? 0,
    })),
    truncated,
  };
}

/**
 * The orders in one bucket, oldest paid first — the order they should be worked.
 *
 * Exceptions are filtered OUT of every non-exception bucket here, mirroring
 * bucketForOrder. An order held by the amount-mismatch check normalises to a
 * status that sits in Ready, so without this it would appear in the pick queue.
 */
export async function getBucketOrders(
  bucket: BucketId,
  opts: { limit?: number } = {},
): Promise<QueueOrder[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));

  if (bucket === "exceptions") return (await getExceptionOrders({ limit })).orders;

  const statuses = rawStatusesForBucket(bucket);
  if (statuses.length === 0) return [];

  // One query per status — see the note at the top of this file.
  const results = await Promise.all(statuses.map(async (status) => {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select(QUEUE_COLUMNS)
      .eq("payment_status", "paid")
      .eq("fulfillment_status", status)
      .neq("order_type", "membership")
      .order("paid_at", { ascending: true, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }));

  const merged = results.flat().map((row) => toQueueOrder(row as unknown as Record<string, unknown>));
  // An exception belongs only to the exception queue.
  const clean = merged.filter((o) => o.exceptions.length === 0 && o.bucket === bucket);
  // Priority first, then oldest-paid first within each band.
  //
  // The queue was pure oldest-first, so an expedited order paid this morning
  // sat behind every standard order from the previous days — and nothing on
  // screen said it was expedited. Sorting here rather than in the component
  // means the API, the page and any future consumer agree on pick order.
  clean.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return String(a.paidAt ?? a.createdAt).localeCompare(String(b.paidAt ?? b.createdAt));
  });
  return clean.slice(0, limit);
}

export interface ExceptionQueue {
  orders: QueueOrder[];
  /**
   * True when the scan ceiling stopped before every candidate order had been
   * examined. The list below is then "some of what needs a human", never "all
   * of it", and the screen must say so.
   */
  truncated: boolean;
}

/**
 * Everything that needs a human, from every source.
 *
 * Deliberately a wider net than the bucket queries: an exception can be caused
 * by a payment status, a Shippo sync status, a stranded label claim or a clock
 * that has run out, none of which is a fulfillment status. Filtering in memory
 * over paid + awaiting verification orders is the honest way to catch all of
 * them at once.
 *
 * THE SCAN USED TO POINT AT THE WRONG END OF THE STORE.
 *
 * It was `.order("paid_at", ascending: true).limit(2000)` — the two thousand
 * OLDEST orders — and then filtered those in memory. Past two thousand paid
 * orders that window is almost entirely long-delivered history, so a Shippo
 * sync that failed this morning, a payment held this afternoon, a label bought
 * yesterday and never scanned were all outside it. They appeared on no screen
 * at all, and the board reported a calm day.
 *
 * Two changes, and both are needed:
 *
 *   1. The scan pages to exhaustion under a ceiling far above any plausible
 *      store, so the window is not a window. `truncated` reports reaching it
 *      rather than returning a shorter list as though it were the answer.
 *   2. It reads NEWEST-first. If the ceiling is ever the binding constraint,
 *      what falls off the end is the oldest history rather than today's work.
 *
 * The RESULT is still ordered oldest-paid first, because that is the order an
 * operator works it. Scan order and work order are different questions, and
 * conflating them is what put the answer two thousand orders in the past.
 */
export async function getExceptionOrders(opts: { limit?: number } = {}): Promise<ExceptionQueue> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));

  const { rows, truncated } = await readAllRowsBounded<Record<string, unknown>>(
    (from, to) =>
      supabaseAdmin
        .from("orders")
        .select(QUEUE_COLUMNS)
        .neq("order_type", "membership")
        .in("payment_status", ["paid", "awaiting_verification"])
        // created_at rather than paid_at: an awaiting_verification order — one
        // of the exception reasons — has no paid_at at all, and ordering a
        // nullable column puts precisely those rows at whichever end the ceiling
        // discards. created_at is present on every row.
        .order("created_at", { ascending: false })
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_BUCKET_ORDERS, label: "exception scan" },
  );

  const orders = rows
    .map((row) => toQueueOrder(row))
    .filter((o) => o.exceptions.length > 0)
    // Oldest first: the one that has been waiting longest is the one that has
    // kept a customer waiting longest.
    .sort((a, b) => String(a.paidAt ?? a.createdAt).localeCompare(String(b.paidAt ?? b.createdAt)))
    .slice(0, limit);

  return { orders, truncated };
}

/** The definitions, for rendering the reason and the action beside each order. */
export { EXCEPTION_REASONS };

/**
 * A cancelled order that already has a Shippo label.
 *
 * The canonical pipeline permits label_purchased -> cancelled, on the sound
 * reasoning that buying a label does not prove the carrier has the parcel. But
 * cancelling the Vanta order does NOT void or refund the Shippo label — this
 * application deliberately cannot buy or void postage automatically — so the
 * operator has an outstanding job in Shippo's dashboard that nothing else will
 * remind them about.
 *
 * Surfaced as its own list rather than folded into the exception queue: it is
 * not a blocked order, it is money that may still be recoverable.
 */
export async function getCancelledWithLabel(opts: { limit?: number } = {}): Promise<QueueOrder[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(QUEUE_COLUMNS)
    .in("fulfillment_status", ["cancelled", "canceled"])
    .not("shippo_transaction_id", "is", null)
    .is("label_voided_at", null)
    .order("paid_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => toQueueOrder(row as unknown as Record<string, unknown>));
}

export { normalizeLegacyStatus };
