import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { bucketForOrder, exceptionsForOrder, inPackingOrder, type OrderBucketInput } from "@/lib/fulfillment-buckets";

// ---------------------------------------------------------------------------
// BATCHES, PICKING AND PACKING.
//
// A batch is an operational grouping and nothing else. It records which orders
// an operator decided to work on together; it stores no payment, inventory,
// fulfillment or shipping state, and adding or removing an order changes
// nothing about that order. Delete every row in both batch tables and no order
// would be wrong — only the grouping would be lost.
//
// NOTHING HERE TOUCHES INVENTORY. Picking is a physical act; the shelf was
// already decremented when the payment settled (finalizeInventoryForOrder in
// the paid side-effects claim). A pick list is a printed instruction, not a
// stock movement, and this file contains no inventory call of any kind.
// ---------------------------------------------------------------------------

export interface FulfillmentBatch {
  id: string;
  label: string;
  status: string;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  orderCount: number;
}

/** `2026-08-22-AM` — something an operator can say out loud. */
export function suggestBatchLabel(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  return `${iso}-${now.getUTCHours() < 12 ? "AM" : "PM"}`;
}

/**
 * Open a batch over the given orders.
 *
 * ELIGIBILITY IS RE-CHECKED HERE, not trusted from the client. The screen the
 * operator selected from was rendered a moment ago; in between, a webhook may
 * have moved an order, a payment may have been held, or a cancellation may have
 * landed. An order that is no longer Ready is reported back rather than quietly
 * batched — the same partial-result honesty the bulk actions use.
 */
export async function createBatch(input: {
  orderIds: string[];
  label?: string;
  createdBy?: string | null;
}): Promise<{ batch: FulfillmentBatch | null; added: string[]; rejected: Array<{ orderId: string; reason: string }> }> {
  const rejected: Array<{ orderId: string; reason: string }> = [];
  const eligible: string[] = [];

  if (input.orderIds.length === 0) {
    return { batch: null, added: [], rejected: [] };
  }

  const { data: rows, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, payment_status, fulfillment_status, shippo_sync_status, label_purchase_claimed_at, shippo_transaction_id, order_type")
    .in("order_id", input.orderIds);
  if (error) throw error;

  const byId = new Map((rows ?? []).map((r) => [String(r.order_id), r]));

  for (const orderId of input.orderIds) {
    const row = byId.get(orderId);
    if (!row) { rejected.push({ orderId, reason: "Order not found." }); continue; }
    if (String(row.order_type ?? "") === "membership") {
      rejected.push({ orderId, reason: "Membership orders are digital and never ship." });
      continue;
    }
    const asInput = row as unknown as OrderBucketInput;
    const problems = exceptionsForOrder(asInput);
    if (problems.length > 0) {
      // THE RULE THAT MATTERS: a held order never enters the pick queue.
      rejected.push({ orderId, reason: `Exception: ${problems.join(", ")}. Resolve it before batching.` });
      continue;
    }
    if (bucketForOrder(asInput) !== "ready") {
      rejected.push({ orderId, reason: `Not ready to fulfil (${String(row.fulfillment_status ?? "unknown")}).` });
      continue;
    }
    eligible.push(orderId);
  }

  if (eligible.length === 0) return { batch: null, added: [], rejected };

  const { data: created, error: batchError } = await supabaseAdmin
    .from("fulfillment_batches")
    .insert({ label: input.label || suggestBatchLabel(), created_by: input.createdBy ?? null })
    .select("id, label, status, created_by, created_at, closed_at")
    .single();
  if (batchError || !created) throw batchError ?? new Error("Could not create the batch.");

  // Insert membership one at a time so a single conflict — an order already in
  // another OPEN batch, caught by the partial unique index — rejects only that
  // order rather than failing the whole batch.
  const added: string[] = [];
  for (const orderId of eligible) {
    const { error: memberError } = await supabaseAdmin
      .from("fulfillment_batch_orders")
      .insert({ batch_id: created.id, order_id: orderId });
    if (memberError) {
      rejected.push({
        orderId,
        reason: memberError.code === "23505"
          ? "Already in another open batch."
          : "Could not be added to the batch.",
      });
      continue;
    }
    added.push(orderId);
  }

  return {
    batch: {
      id: String(created.id),
      label: String(created.label),
      status: String(created.status),
      createdBy: created.created_by ? String(created.created_by) : null,
      createdAt: String(created.created_at),
      closedAt: created.closed_at ? String(created.closed_at) : null,
      orderCount: added.length,
    },
    added,
    rejected,
  };
}

export async function listBatches(opts: { status?: string; limit?: number } = {}): Promise<FulfillmentBatch[]> {
  let query = supabaseAdmin
    .from("fulfillment_batches")
    .select("id, label, status, created_by, created_at, closed_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(100, opts.limit ?? 25));
  if (opts.status) query = query.eq("status", opts.status);

  const { data, error } = await query;
  if (error) throw error;

  const ids = (data ?? []).map((b) => String(b.id));
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: members } = await supabaseAdmin
      .from("fulfillment_batch_orders")
      .select("batch_id")
      .in("batch_id", ids)
      .is("removed_at", null);
    for (const m of members ?? []) {
      const key = String(m.batch_id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return (data ?? []).map((b) => ({
    id: String(b.id),
    label: String(b.label),
    status: String(b.status),
    createdBy: b.created_by ? String(b.created_by) : null,
    createdAt: String(b.created_at),
    closedAt: b.closed_at ? String(b.closed_at) : null,
    orderCount: counts.get(String(b.id)) ?? 0,
  }));
}

export async function closeBatch(batchId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("fulfillment_batches")
    .update({ status: "closed", closed_at: now, updated_at: now })
    .eq("id", batchId);
  if (error) throw error;
}

/** Pull one order out of a batch. A timestamp, not a delete — see the migration. */
export async function removeFromBatch(batchId: string, orderId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("fulfillment_batch_orders")
    .update({ removed_at: new Date().toISOString() })
    .eq("batch_id", batchId)
    .eq("order_id", orderId)
    .is("removed_at", null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// THE CONSOLIDATED PICK LIST.
//
// The highest-value thing in Phase B: one walk of the shelves per SKU instead
// of one per order.
//
// AGGREGATION KEY. `order_items.product_id` holds a composite that is already
// stable and immutable — `slug::product_doses.id`, e.g.
// `bacteriostatic-water::e029273d-…`. It is the same key inventory reserves
// against, so grouping on it cannot disagree with the shelf. NOTHING here
// matches on a product NAME: names are display text, they change, and two
// doses of one product share one. Names are joined afterwards, for the printed
// sheet only.
//
// The dose half matters. A dosed product holds its stock on `product_doses`,
// not on `products`, and grouping by product would tell a picker to fetch four
// of something without saying which strength.
// ---------------------------------------------------------------------------

export interface PickLine {
  /** slug::doseId — immutable, and the key inventory uses. */
  productId: string;
  productName: string;
  /** Total units to pull for the whole batch. */
  quantity: number;
  /** How many separate orders contribute, so a picker can sanity-check. */
  orderCount: number;
}

export interface PickList {
  batchId: string;
  batchLabel: string;
  orderCount: number;
  lines: PickLine[];
  totalUnits: number;
}

export async function getPickList(batchId: string): Promise<PickList | null> {
  const { data: batch } = await supabaseAdmin
    .from("fulfillment_batches")
    .select("id, label")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return null;

  const { data: members, error: memberError } = await supabaseAdmin
    .from("fulfillment_batch_orders")
    .select("order_id")
    .eq("batch_id", batchId)
    .is("removed_at", null);
  if (memberError) throw memberError;

  const orderIds = (members ?? []).map((m) => String(m.order_id));
  if (orderIds.length === 0) {
    return { batchId, batchLabel: String(batch.label), orderCount: 0, lines: [], totalUnits: 0 };
  }

  // A CANCELLED OR REFUNDED ORDER MUST DROP OUT OF THE REQUIREMENT.
  //
  // Membership is operational, so an order cancelled after the batch was
  // created is still a member — but nobody should pick for it. Re-reading the
  // payment status here means the sheet is correct at the moment it is printed
  // rather than at the moment the batch was made.
  const { data: liveOrders, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id, payment_status, fulfillment_status")
    .in("order_id", orderIds);
  if (orderError) throw orderError;

  const pickable = new Set(
    (liveOrders ?? [])
      .filter((o) => String(o.payment_status ?? "") === "paid")
      .filter((o) => !["cancelled", "canceled", "refunded", "returned"].includes(String(o.fulfillment_status ?? "")))
      .map((o) => String(o.order_id)),
  );

  const { data: items, error: itemError } = await supabaseAdmin
    .from("order_items")
    .select("order_id, product_id, product_name, quantity")
    .in("order_id", [...pickable]);
  if (itemError) throw itemError;

  const byProduct = new Map<string, { name: string; quantity: number; orders: Set<string> }>();
  for (const item of items ?? []) {
    // A line with no product_id cannot be picked reliably — it would have to be
    // matched by name, which is exactly what this design refuses to do. Such a
    // line is surfaced under its own key so it is visible rather than dropped.
    const key = String(item.product_id ?? "").trim() || "(missing product id)";
    const entry = byProduct.get(key) ?? { name: String(item.product_name ?? key), quantity: 0, orders: new Set() };
    // Free, promotional and BOGO items are ordinary rows carrying a quantity,
    // so they aggregate correctly with no special case. A bundle that expands
    // into its component lines aggregates the same way.
    entry.quantity += Number(item.quantity ?? 0);
    entry.orders.add(String(item.order_id));
    byProduct.set(key, entry);
  }

  const lines: PickLine[] = [...byProduct.entries()]
    .map(([productId, v]) => ({
      productId,
      productName: v.name,
      quantity: v.quantity,
      orderCount: v.orders.size,
    }))
    .sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName));

  return {
    batchId,
    batchLabel: String(batch.label),
    orderCount: pickable.size,
    lines,
    totalUnits: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

// ---------------------------------------------------------------------------
// THE PACKING QUEUE.
//
// One order at a time, in the order they were paid. APPROACH B: verify this
// order's contents, obtain THIS order's label, apply it, move on. The
// alternative — printing a hundred labels and then packing against the stack —
// is faster per label and puts a transposition error one slip of the hand away.
// A mislabelled research-chemical parcel is a compliance incident, not a
// refund, so the slower workflow is the correct one.
// ---------------------------------------------------------------------------

export interface PackingItem {
  productId: string;
  productName: string;
  quantity: number;
}

export interface PackingOrder {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  destination: string;
  items: PackingItem[];
  totalUnits: number;
  fulfillmentStatus: string;
  hasLabel: boolean;
  labelUrl: string | null;
  trackingNumber: string | null;
  /**
   * Carrier and service, shown at the bench so the packer knows whether they
   * are holding a UPS Ground or a USPS Ground Advantage parcel without opening
   * Shippo to find out.
   */
  carrier: string | null;
  service: string | null;
  /** Position in the batch, for "order 12 of 99". */
  position: number;
  ofTotal: number;
}

/**
 * The next order to pack in this batch, or null when the batch is done.
 *
 * "Next" means the oldest paid order in the batch that has not yet been packed
 * or labelled. Re-reading state on every call is what makes the queue resumable:
 * close the browser mid-batch and the same call returns the same next order.
 * Nothing about the operator's position is stored client-side.
 */
export async function getNextToPack(batchId: string): Promise<PackingOrder | null> {
  const { data: members } = await supabaseAdmin
    .from("fulfillment_batch_orders")
    .select("order_id")
    .eq("batch_id", batchId)
    .is("removed_at", null);

  const orderIds = (members ?? []).map((m) => String(m.order_id));
  if (orderIds.length === 0) return null;

  // The SAME ordering the label sheet uses — from the same function, not a
  // second copy of the clause. Page 1 must be parcel 1.
  const { data: orders, error } = await inPackingOrder(
    supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_name, city, state, country, payment_status, fulfillment_status, label_url, tracking_number, shippo_transaction_id, shipping_carrier, shipping_service, label_voided_at, paid_at")
      .in("order_id", orderIds),
  );
  if (error) throw error;

  const live = (orders ?? []).filter((o) => String(o.payment_status ?? "") === "paid");
  // Already packed or beyond — nothing left to do at the bench.
  const DONE = new Set(["packed", "label_purchased", "shipped", "in_transit", "out_for_delivery", "delivered", "cancelled", "canceled", "refunded", "returned"]);
  const remaining = live.filter((o) => !DONE.has(String(o.fulfillment_status ?? "")));
  const next = remaining[0];
  if (!next) return null;

  const { data: items } = await supabaseAdmin
    .from("order_items")
    .select("product_id, product_name, quantity")
    .eq("order_id", String(next.order_id));

  const packItems: PackingItem[] = (items ?? []).map((i) => ({
    productId: String(i.product_id ?? ""),
    productName: String(i.product_name ?? ""),
    quantity: Number(i.quantity ?? 0),
  }));

  return {
    orderId: String(next.order_id),
    orderNumber: next.order_number ? String(next.order_number) : null,
    customerName: next.customer_name ? String(next.customer_name) : null,
    destination: [next.city, next.state, next.country].filter(Boolean).join(", "),
    items: packItems,
    totalUnits: packItems.reduce((s, i) => s + i.quantity, 0),
    fulfillmentStatus: String(next.fulfillment_status ?? ""),
    // A voided label is not a label — the carrier has been told that parcel is
    // not coming, so the bench must not offer it for printing.
    hasLabel: Boolean((next.shippo_transaction_id || next.label_url) && !next.label_voided_at),
    carrier: next.shipping_carrier ? String(next.shipping_carrier) : null,
    service: next.shipping_service ? String(next.shipping_service) : null,
    labelUrl: next.label_url ? String(next.label_url) : null,
    trackingNumber: next.tracking_number ? String(next.tracking_number) : null,
    position: live.length - remaining.length + 1,
    ofTotal: live.length,
  };
}
