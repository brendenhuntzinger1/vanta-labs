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
  + "label_purchase_claimed_at, paid_at, created_at";

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
}

function toQueueOrder(row: Record<string, unknown>, batchId: string | null = null): QueueOrder {
  const input: OrderBucketInput = {
    payment_status: String(row.payment_status ?? ""),
    fulfillment_status: String(row.fulfillment_status ?? ""),
    shippo_sync_status: row.shippo_sync_status ? String(row.shippo_sync_status) : null,
    label_purchase_claimed_at: row.label_purchase_claimed_at ? String(row.label_purchase_claimed_at) : null,
    shippo_transaction_id: row.shippo_transaction_id ? String(row.shippo_transaction_id) : null,
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

/**
 * How many orders sit in each bucket right now.
 *
 * ONE query for the whole board, not one per bucket: the counts index is a
 * partial index on fulfillment_status restricted to paid physical orders, so
 * this is an index-only scan. Bucketing happens in memory over a few hundred
 * status/payment pairs, which is free compared to another round trip.
 */
export async function getBucketCounts(): Promise<BucketCount[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("payment_status, fulfillment_status, shippo_sync_status, label_purchase_claimed_at, shippo_transaction_id")
    .neq("order_type", "membership")
    .in("payment_status", ["paid", "awaiting_verification"]);

  if (error) throw error;

  const tally = new Map<BucketId, number>();
  for (const row of data ?? []) {
    const bucket = bucketForOrder(row as OrderBucketInput);
    if (!bucket) continue;
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
  }

  return BUCKETS.map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    operational: b.operational,
    count: tally.get(b.id) ?? 0,
  }));
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

  if (bucket === "exceptions") return getExceptionOrders({ limit });

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
  clean.sort((a, b) => String(a.paidAt ?? a.createdAt).localeCompare(String(b.paidAt ?? b.createdAt)));
  return clean.slice(0, limit);
}

/**
 * Everything that needs a human, from every source.
 *
 * Deliberately a wider net than the bucket queries: an exception can be caused
 * by a payment status, a Shippo sync status or a stranded label claim, none of
 * which is a fulfillment status. Filtering in memory over paid + awaiting
 * verification orders is the honest way to catch all of them at once.
 */
export async function getExceptionOrders(opts: { limit?: number } = {}): Promise<QueueOrder[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(QUEUE_COLUMNS)
    .neq("order_type", "membership")
    .in("payment_status", ["paid", "awaiting_verification"])
    .order("paid_at", { ascending: true, nullsFirst: false })
    .limit(2000);
  if (error) throw error;

  return (data ?? [])
    .map((row) => toQueueOrder(row as unknown as Record<string, unknown>))
    .filter((o) => o.exceptions.length > 0)
    .slice(0, limit);
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
