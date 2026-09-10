import "server-only";

import { finalizeInventoryForOrder } from "@/lib/inventory-reservation";
import { decrementInventoryForOrder, itemsNotFinalized } from "@/lib/inventory-fulfillment";
import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// PAID, BUT THE STOCK NEVER MOVED.
//
// The paid side-effects claim is taken BEFORE any effect runs — one atomic
// `update(paid_side_effects_at).is(paid_side_effects_at, null)` — and that is
// deliberate: it is what stops a redelivered webhook from emailing a second
// receipt and decrementing stock twice. But the claim is single-use and nothing
// ever marks it COMPLETE, so an invocation killed between taking the claim and
// finishing its work leaves the order paid with the work permanently undone.
// The processor's retry finds the claim spent and does nothing.
//
// A serverless function has several ordinary ways to die mid-run: the platform's
// wall-clock limit, a deploy rolling the container, an OOM. None of them is
// exotic, and none of them leaves a trace on the order beyond an absence.
//
// Of the four effects behind that claim, three already have repair jobs in the
// sweep — commissionAccrualRepair, orderEmailReaper/emailRetry, and
// customerOfferRepair. INVENTORY had none, and it is the one that costs money in
// both directions: stock that was sold but never decremented is oversold to the
// next shopper, and `inventory_committed_at` left NULL is also what the cancel
// path reads, so a later cancel under-restocks instead.
//
// So this job asks the absence question the others ask: which PAID orders have
// no inventory receipt? Both repair calls are the same ones the webhook makes
// and both are idempotent — finalize_inventory_for_order only moves rows still
// holding, and the fallback decrement refuses units another order holds — so a
// re-run cannot double a decrement.
//
// It deliberately does NOT write inventory_committed_at unless the stock
// actually moved, for the reason the webhook documents: a receipt on a partial
// decrement would make a later cancel invent units. Under-restock is a
// recoverable inconvenience; over-restock is a money-losing oversell.
// ---------------------------------------------------------------------------

/**
 * How long after payment an order is considered stranded rather than in-flight.
 *
 * The paid path does its inventory work inside the webhook request, so a few
 * seconds is normal and a few minutes is not. Ten minutes is far past any
 * legitimate run and still well inside the window where a cancel or a refund is
 * unlikely to have happened yet.
 */
const STRANDED_AFTER_MS = 10 * 60 * 1000;

/** Look back a week: long enough to clear a backlog, short enough to stay cheap. */
const DEFAULT_LOOKBACK_DAYS = 7;

/** Bound the work per tick — the sweep shares a 60-second budget with ~25 jobs. */
const DEFAULT_LIMIT = 25;

export interface InventoryCommitRepairResult {
  scanned: number;
  repaired: number;
  /** Stock moved, but not every line did, so no receipt was written. */
  partial: number;
  failed: number;
  /** Candidates left for the next tick by `limit`. */
  deferred?: number;
}

/**
 * Re-run the inventory commit for paid orders that never got one.
 *
 * Absence-keyed and idempotent, in the shape of repairMissingCommissionAccruals:
 * it finds orders whose receipt column is NULL rather than tracking failures, so
 * it clears the existing backlog as well as protecting future orders. Never
 * throws — the sweep reports a rejected job, and this one failing must not take
 * the other jobs' results down with it.
 */
export async function repairMissingInventoryCommits(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<InventoryCommitRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const strandedBefore = new Date(now.getTime() - STRANDED_AFTER_MS).toISOString();

  const result: InventoryCommitRepairResult = { scanned: 0, repaired: 0, partial: 0, failed: 0 };

  // Only PRODUCT orders hold stock. A membership charge has no lines, and
  // filtering here rather than per-candidate keeps the scan honest: a window
  // full of memberships must not hide a stranded product order.
  const { data: candidates, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, paid_at, order_type")
    .in("payment_status", ["paid", "partially_refunded"])
    .is("inventory_committed_at", null)
    .is("inventory_restocked_at", null)
    .gte("paid_at", since)
    .lte("paid_at", strandedBefore)
    .order("paid_at", { ascending: true })
    .limit(Math.max(1, limit) * 4);

  if (error || !candidates) return result;

  const stranded = candidates.filter((order) => {
    const type = String(order.order_type ?? "product").toLowerCase();
    return type === "product" || type === "";
  });
  result.scanned = stranded.length;
  if (stranded.length === 0) return result;

  const toRepair = stranded.slice(0, Math.max(0, limit));
  if (stranded.length > toRepair.length) result.deferred = stranded.length - toRepair.length;

  for (const order of toRepair) {
    const orderId = String(order.order_id);
    try {
      // The same two calls the paid path makes, in the same order and with the
      // same reasoning: finalize what is still held, then decrement only the
      // lines finalize did not move.
      const fin = await finalizeInventoryForOrder(orderId);
      const finalizedLines = fin.finalizedLines ?? null;
      const finalizeCoveredOrder = !fin.degraded && finalizedLines === null && fin.finalized > 0;

      let moved = fin.finalized > 0;
      let everyLineMoved = finalizeCoveredOrder;

      if (!finalizeCoveredOrder) {
        const { data: soldItems, error: itemsError } = await supabaseAdmin
          .from("order_items")
          .select("product_id, quantity")
          .eq("order_id", orderId);

        // An unreadable line list is not an order with no lines. Decrementing
        // nothing and reporting success is how sold stock stays on the shelf.
        if (itemsError || !soldItems) {
          result.failed += 1;
          continue;
        }

        // itemsNotFinalized is the SAME matcher the webhook uses — the lines are
        // keyed by slug/variant, not by product_id string equality, so matching
        // them by hand here would decrement a dose-stocked line twice.
        const items = soldItems as Array<{ product_id?: string | null; quantity?: number | null }>;
        const remaining = fin.degraded || finalizedLines === null
          ? items
          : itemsNotFinalized(items, finalizedLines);

        if (remaining.length > 0) {
          const decrement = await decrementInventoryForOrder(remaining, orderId);
          moved = moved || decrement.attempted > decrement.failed;
          everyLineMoved = decrement.failed === 0;
        } else {
          everyLineMoved = true;
        }

        // A degraded finalize leaves this order's holds active while the
        // fallback moves the units directly, so the stock ends up both
        // decremented and permanently reserved. The webhook releases them for
        // exactly this reason; so does the repair.
        if (fin.degraded && moved) {
          const { releaseInventoryForOrder } = await import("@/lib/inventory-reservation");
          await releaseInventoryForOrder(orderId).catch(() => {});
        }
      }

      if (moved && everyLineMoved) {
        // The receipt, written only once and only when the whole order moved —
        // the same compare-and-set the webhook uses, so a concurrent webhook
        // finishing its own work first simply wins and this no-ops.
        await supabaseAdmin
          .from("orders")
          .update({ inventory_committed_at: new Date().toISOString() })
          .eq("order_id", orderId)
          .is("inventory_committed_at", null);
        result.repaired += 1;
      } else if (moved) {
        // Some lines moved and some did not. No receipt: it would make a later
        // cancel invent units for the lines that never moved.
        result.partial += 1;
        await recordSystemAlert({
          type: "inventory_commit_repair_partial",
          severity: "warning",
          message: `Order ${orderId} is paid and its stock moved only partially. No inventory receipt was written, so a `
            + "later cancel will under-restock rather than over-restock. Check the lines by hand.",
          context: { order_id: orderId },
        }).catch(() => {});
      } else {
        result.failed += 1;
        await recordSystemAlert({
          type: "inventory_commit_repair_failed",
          severity: "critical",
          message: `Order ${orderId} has been paid since ${String(order.paid_at)} and its stock has still not been `
            + "decremented. The units are sold but remain on the shelf, so they can be oversold to another shopper.",
          context: { order_id: orderId, paid_at: order.paid_at },
        }).catch(() => {});
      }
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
