import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getRatesForOrder, purchaseLabelForOrder } from "@/lib/shippo/service";
import { bucketForOrder, inPackingOrder } from "@/lib/fulfillment-buckets";

// ---------------------------------------------------------------------------
// BATCH LABELS: REVIEW FIRST, THEN SPEND.
//
// Two operations, deliberately separate, because one of them costs money:
//
//   reviewBatchLabels()   quotes everything and reports what a purchase WOULD
//                         cost. Spends nothing. Safe to call on render, on
//                         refresh, as often as you like.
//   purchaseBatchLabels() buys. Called only from an explicit admin POST that
//                         names the orders, after the operator has seen the
//                         review and confirmed the total.
//
// The split is the safety property. Nothing that renders a page can spend a
// cent, and the number the operator confirms is the number they were shown.
// ---------------------------------------------------------------------------

/** An order's readiness to have postage bought for it. */
export type LabelReadiness =
  | "ready"          // quoted, no label yet — will be bought
  | "already_bought" // has a live label — skipped, costs nothing
  | "needs_attention"; // cannot be quoted, or is not eligible

export interface LabelReviewLine {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  destination: string;
  readiness: LabelReadiness;
  /** Cheapest quoted rate, in cents. Null when nothing could be quoted. */
  estimatedCents: number | null;
  carrier: string | null;
  service: string | null;
  /** The rate the purchase would use. Held so the operator buys what they saw. */
  rateId: string | null;
  /** Plain English. Shown verbatim to the operator — never a status code. */
  note: string | null;
}

export interface LabelReview {
  batchId: string;
  lines: LabelReviewLine[];
  readyCount: number;
  alreadyBoughtCount: number;
  needsAttentionCount: number;
  /** Total of the ready lines only. Already-bought and blocked lines add nothing. */
  estimatedTotalCents: number;
}

interface BatchOrderRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  shippo_transaction_id: string | null;
  label_voided_at: string | null;
  label_purchase_claimed_at: string | null;
  shippo_sync_status: string | null;
}

const ORDER_COLUMNS =
  "order_id, order_number, customer_name, city, state, country, payment_status, fulfillment_status, " +
  "shippo_transaction_id, label_voided_at, label_purchase_claimed_at, shippo_sync_status";

/**
 * Members of a batch, in the SAME order the packing bench serves them.
 *
 * Shared by the review, the purchase and the label PDF so all three agree. A
 * label sheet whose order differs from the packing order is how the wrong label
 * goes on the wrong parcel.
 */
export async function batchOrdersInPackingOrder(batchId: string): Promise<BatchOrderRow[]> {
  const { data: members } = await supabaseAdmin
    .from("fulfillment_batch_orders")
    .select("order_id")
    .eq("batch_id", batchId)
    .is("removed_at", null);

  const orderIds = (members ?? []).map((m) => String(m.order_id));
  if (orderIds.length === 0) return [];

  const { data, error } = await inPackingOrder(
    supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .in("order_id", orderIds),
  );
  if (error) throw error;
  return (data ?? []) as unknown as BatchOrderRow[];
}

function destinationOf(row: BatchOrderRow): string {
  return [row.city, row.state, row.country].filter(Boolean).join(", ");
}

/** Does this order already hold a label that has not been voided? */
function hasLiveLabel(row: BatchOrderRow): boolean {
  return Boolean(row.shippo_transaction_id) && !row.label_voided_at;
}

/**
 * Quote every order in the batch and report what buying would cost.
 *
 * SPENDS NOTHING. Quoting is a free Shippo call.
 *
 * A line that cannot be quoted is reported as needs_attention with the reason
 * in plain English — it does NOT stop the others. Two bad shipments must never
 * make the other ninety-three impossible to process.
 */
export async function reviewBatchLabels(batchId: string): Promise<LabelReview> {
  const rows = await batchOrdersInPackingOrder(batchId);
  const lines: LabelReviewLine[] = [];

  for (const row of rows) {
    const base = {
      orderId: row.order_id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      destination: destinationOf(row),
      carrier: null as string | null,
      service: null as string | null,
      rateId: null as string | null,
    };

    if (hasLiveLabel(row)) {
      lines.push({
        ...base,
        readiness: "already_bought",
        estimatedCents: null,
        note: "Already has a label. It will be skipped and cost nothing.",
      });
      continue;
    }

    // An unresolved claim means a previous purchase's outcome is unknown.
    // Buying again could be the second charge this whole design prevents.
    if (row.label_purchase_claimed_at) {
      lines.push({
        ...base,
        readiness: "needs_attention",
        estimatedCents: null,
        note: "A previous label purchase never confirmed. Verify it in Shippo before buying again.",
      });
      continue;
    }

    // The same rule the pick queue uses, so an order held back there is held
    // back here too rather than quietly having postage bought for it.
    const bucket = bucketForOrder({
      payment_status: row.payment_status,
      fulfillment_status: row.fulfillment_status,
      shippo_sync_status: row.shippo_sync_status,
      label_purchase_claimed_at: row.label_purchase_claimed_at,
      shippo_transaction_id: row.shippo_transaction_id,
    });
    if (bucket === "exceptions" || bucket === "terminal" || bucket === null) {
      lines.push({
        ...base,
        readiness: "needs_attention",
        estimatedCents: null,
        note: "This order is not eligible for shipping right now. Resolve it in Needs Attention first.",
      });
      continue;
    }

    const quote = await getRatesForOrder(row.order_id);
    if (!quote.ok) {
      lines.push({
        ...base,
        readiness: "needs_attention",
        estimatedCents: null,
        note: quote.message,
      });
      continue;
    }

    // Rates come back cheapest first.
    const cheapest = quote.data.rates[0];
    if (!cheapest) {
      lines.push({
        ...base,
        readiness: "needs_attention",
        estimatedCents: null,
        note: "No carrier offered a rate for this address and parcel.",
      });
      continue;
    }

    lines.push({
      ...base,
      readiness: "ready",
      estimatedCents: Math.round(Number(cheapest.amount ?? 0) * 100) || null,
      carrier: cheapest.provider ?? null,
      service: cheapest.servicelevel?.name ?? null,
      rateId: cheapest.object_id ?? null,
      note: null,
    });
  }

  return {
    batchId,
    lines,
    readyCount: lines.filter((l) => l.readiness === "ready").length,
    alreadyBoughtCount: lines.filter((l) => l.readiness === "already_bought").length,
    needsAttentionCount: lines.filter((l) => l.readiness === "needs_attention").length,
    estimatedTotalCents: lines
      .filter((l) => l.readiness === "ready")
      .reduce((sum, l) => sum + (l.estimatedCents ?? 0), 0),
  };
}

/** What actually happened to one order when the money was spent. */
export type PurchaseOutcome = "purchased" | "already_had_one" | "failed" | "needs_verification";

export interface PurchaseResultLine {
  orderId: string;
  orderNumber: string | null;
  outcome: PurchaseOutcome;
  trackingNumber: string | null;
  carrier: string | null;
  postageCostCents: number | null;
  /** Plain English, shown to the operator. */
  message: string | null;
}

export interface BatchPurchaseResult {
  purchased: number;
  alreadyHadOne: number;
  failed: number;
  needsVerification: number;
  spentCents: number;
  lines: PurchaseResultLine[];
}

/**
 * Codes meaning "we do not know whether postage was charged".
 *
 * These become needs_verification, NEVER a retry. purchaseLabelForOrder keeps
 * the claim for exactly these cases, so a second attempt is refused anyway —
 * this is what turns that refusal into something the operator can read.
 */
const AMBIGUOUS_CODES = new Set([
  "timeout",
  "network",
  "invalid_response",
  "missing_cost",
  "db_error",
  "cost_unrecorded",
  "purchase_in_progress",
]);

/**
 * BUY THE POSTAGE for the named orders. SPENDS MONEY.
 *
 * Called only from an explicit admin POST that lists the order ids — never from
 * a batch id alone, so the set that gets bought is the set the operator
 * confirmed, even if the batch changed underneath them.
 *
 * SEQUENTIAL ON PURPOSE. Concurrency here would multiply the blast radius of a
 * Shippo incident across the whole batch before anyone could react, and the
 * per-order claim already makes each purchase independent. Callers send modest
 * chunks so no single request runs long.
 *
 * PARTIAL FAILURE IS THE NORMAL CASE, not the exception. Every order is
 * reported individually. One failure never rolls back or blocks the others, and
 * nothing is retried automatically.
 */
export async function purchaseBatchLabels(
  targets: Array<{ orderId: string; rateId?: string | null }>,
  actor: string | null,
): Promise<BatchPurchaseResult> {
  const lines: PurchaseResultLine[] = [];

  for (const { orderId, rateId } of targets) {
    try {
      const result = await purchaseLabelForOrder({
        orderId,
        // THE RATE THE OPERATOR WAS SHOWN AND CONFIRMED.
        //
        // Passing only `cheapest` here would skip the quoted-rate cache and
        // re-quote at purchase time, so a rate that moved between the review
        // and the click would be bought silently — and the total on the
        // confirmation dialog would not be the total charged.
        //
        // `cheapest` remains as the fallback for a line whose quote expired,
        // because refusing to ship is worse than buying the cheapest available
        // service, which is what the review offered anyway.
        selection: rateId ? { rateId, cheapest: true } : { cheapest: true },
        actor,
      });

      if (result.ok) {
        lines.push({
          orderId,
          orderNumber: result.data.orderNumber,
          // `reused` means the label already existed — no money moved, and it
          // must not be counted as a purchase in the total spent.
          outcome: result.data.reused ? "already_had_one" : "purchased",
          trackingNumber: result.data.trackingNumber,
          carrier: result.data.carrier,
          postageCostCents: result.data.reused ? null : result.data.postageCostCents,
          message: null,
        });
        continue;
      }

      const ambiguous = AMBIGUOUS_CODES.has(result.code);
      lines.push({
        orderId,
        orderNumber: null,
        outcome: ambiguous ? "needs_verification" : "failed",
        trackingNumber: null,
        carrier: null,
        postageCostCents: null,
        message: ambiguous
          ? `${result.message} Postage may have been charged — verify before buying again.`
          : result.message,
      });
    } catch (error) {
      // A throw leaves the outcome unknown, which is the ambiguous case.
      console.error("Label purchase threw for order", orderId, error);
      lines.push({
        orderId,
        orderNumber: null,
        outcome: "needs_verification",
        trackingNumber: null,
        carrier: null,
        postageCostCents: null,
        message: "The purchase did not confirm. Verify it in Shippo before buying again.",
      });
    }
  }

  return {
    purchased: lines.filter((l) => l.outcome === "purchased").length,
    alreadyHadOne: lines.filter((l) => l.outcome === "already_had_one").length,
    failed: lines.filter((l) => l.outcome === "failed").length,
    needsVerification: lines.filter((l) => l.outcome === "needs_verification").length,
    spentCents: lines.reduce((sum, l) => sum + (l.postageCostCents ?? 0), 0),
    lines,
  };
}

/**
 * Every printable label in the batch, in packing order.
 *
 * Reads stored labels only — never calls Shippo, so printing and reprinting are
 * free and can never buy postage. Voided labels are excluded: the carrier has
 * been told that parcel is not coming.
 */
export async function batchLabelUrls(
  batchId: string,
): Promise<Array<{ orderId: string; orderNumber: string | null; labelUrl: string; position: number }>> {
  const rows = await batchOrdersInPackingOrder(batchId);
  const { data } = await supabaseAdmin
    .from("orders")
    .select("order_id, label_url")
    .in("order_id", rows.map((r) => r.order_id));

  const urls = new Map((data ?? []).map((r) => [String(r.order_id), r.label_url ? String(r.label_url) : null]));

  const printable: Array<{ orderId: string; orderNumber: string | null; labelUrl: string; position: number }> = [];
  rows.forEach((row) => {
    if (!hasLiveLabel(row)) return;
    const url = urls.get(row.order_id);
    if (!url) return;
    printable.push({
      orderId: row.order_id,
      orderNumber: row.order_number,
      labelUrl: url,
      // 1-based, and the same number the packing bench shows.
      position: printable.length + 1,
    });
  });
  return printable;
}
