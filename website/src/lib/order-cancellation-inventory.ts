import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import {
  claimInventoryRestock,
  INVENTORY_ACTOR_ADMIN_CANCELLATION,
  restockInventoryForOrder,
  type OrderItemRef,
} from "@/lib/inventory-fulfillment";
import { releaseInventoryForOrder } from "@/lib/inventory-reservation";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * RETURN THE STOCK A CANCELLED ORDER WAS HOLDING.
 *
 * WHY THIS EXISTS (audit finding K-17). The admin cancel action wrote a status
 * and nothing else. `order-pipeline.ts` contains no inventory reference at all,
 * and none of the four inventory-return call sites in the repo was in the admin
 * route. So cancelling a PAID order left `inventory_quantity` permanently
 * decremented: the reservation had already moved to `finalized`, and
 * `expire_stale_reservations` only reclaims rows still `active`, so nothing
 * anywhere returned those units. The store honoured the cancellation its own
 * Return & Reimbursement Policy invites and silently wrote off the stock.
 *
 * THE INTENDED BEHAVIOUR was already written down in two places:
 *
 *   `restockInventoryForOrder` — "Return stock when a paid order is fully
 *   refunded OR CANCELED — the exact inverse of the decrement above, so tracked
 *   stock nets back to where it began."
 *
 *   The admin REFUND path — which correctly does NOT restock, because a returned
 *   vial may have spent a week in a mailbox — closes by naming the opposite case:
 *   "an order the customer never received (a failed or cancelled order whose
 *   goods never left), which is a different situation."
 *
 * A cancel is USUALLY that different situation — but NOT by construction, and
 * the earlier wording here claimed otherwise. It said `FULFILLMENT_TRANSITIONS`
 * reaches `cancelled` only from `awaiting_payment`, `paid`, `ready_to_fulfill`
 * and `packed`, "every one pre-carrier". That is false: `label_purchased` also
 * carries a `cancelled` edge (order-pipeline.ts:271-280), and the app knows it —
 * `fulfillment-workstation.tsx` renders a dedicated queue for cancelled orders
 * that already have a purchased label.
 *
 * So postage may already be paid and the parcel may already be with the carrier.
 * That case is handled by the CALLER — `setOrderFulfillmentStatus` refuses to
 * restock a cancel out of `label_purchased` and raises an alert instead, because
 * restocking there would INVENT units. Everything below assumes it was filtered
 * out upstream.
 *
 * The rule "No cancel after shipping: the goods are gone" does hold from
 * `shipped` onward.
 *
 * THREE THINGS MUST NOT HAPPEN, and the branch below is what prevents each:
 *
 *   DESTROYED    — a paid order's units never come back. Fixed by restocking.
 *
 *   DUPLICATED   — the stock comes back twice, from a cancel and then a
 *                  processor refund. Prevented by `claimInventoryRestock`, the
 *                  same conditional `inventory_restocked_at` NULL→now claim the
 *                  webhook refund path uses, so whichever runs first wins and the
 *                  other is a no-op.
 *
 *   INVENTED     — an order cancelled from `awaiting_payment` was never
 *                  decremented; its reservation is still `active` and merely
 *                  HOLDS stock. Restocking it would add units that were never
 *                  removed — phantom stock, which oversells. That order needs its
 *                  RESERVATION RELEASED instead.
 *
 * `orders.inventory_committed_at` is the signal: the latch both paid lanes write
 * AFTER their stock has actually moved. Asking "was this order paid?" via
 * `payment_status` would be a proxy; asking whether the decrement happened is
 * the question itself.
 *
 * IT USED TO READ `paid_side_effects_at`, AND THAT COLUMN CANNOT ANSWER THIS
 * QUESTION (VL-10 / INV-01 / F1). In the card lane that latch is the
 * exactly-once CLAIM over every paid side effect, so it is taken BEFORE they run
 * — it has to be, or a duplicate webhook delivery pays the ambassador twice. It
 * means "this delivery won the right to try", not "the units left the shelf",
 * and it is stamped whether the decrement then succeeds, fails, or moves only
 * some lines. Reading it here as proof of the decrement meant that cancelling an
 * order whose decrement had FAILED took the restock branch below and returned
 * units that were never removed: invented stock, which oversells — the exact
 * failure this branch exists to prevent.
 *
 * The manual lane had already reached this conclusion and simply withholds its
 * latch when the decrement does not complete. The card lane cannot do that
 * without giving up its claim, so the claim and the receipt are two columns now.
 *
 * THE RECEIPT IS WRITTEN BY BOTH PAID LANES — processPaymentWebhook and
 * finalizeManualPayment, the only two, both named here so the next author does
 * not have to discover the contract by losing inventory. If a third is ever
 * added it MUST stamp `inventory_committed_at` after its stock moves, and only
 * then. A partial decrement deliberately leaves it NULL: restocking returns
 * EVERY line, so a receipt on a partial would invent units for the lines that
 * never moved. Under-restock is a recoverable inconvenience; over-restock is a
 * money-losing oversell, and `inventory_partially_decremented` tells a human
 * which units to correct by hand.
 *
 * WHY THE ITEM SELECT NAMES NO `variant_id` (VL-1 / DB-01). It used to, and
 * `order_items` HAS NO SUCH COLUMN — not in production, and not in any of the
 * four `create table public.order_items` statements in src/lib/sql/. PostgREST
 * answers a select naming an absent column with 42703, an ERROR rather than a
 * null field, so `error` was always set, this function always took its "do not
 * guess" branch, and EVERY cancellation returned `unavailable`. The whole return
 * path was inert: no cancel ever put stock back, and the alert it raised each
 * time named the read rather than the schema. The variant lives INSIDE
 * `product_id` as `"<slug>::<dose-uuid>"`, which is what `parseOrderItemRef`
 * exists to split apart — so `product_id` alone carries everything the restock
 * needs.
 *
 * WHAT NOW CATCHES IT. supabase-schema-parity.test.ts used to STRIP embedded
 * resources — `order_items(...)` named a relation, not a column of `orders`, so
 * its columns were discarded rather than checked against anything. That is the
 * blind spot VL-1 walked through. It now resolves each embedded select against
 * the EMBEDDED table, so a repeat of this select fails the suite instead of
 * production.
 *
 * WHO CALLS THIS, AND WHY YOU SHOULD NOT NEED TO KNOW.
 *
 * The earlier wording here said "Any future path that cancels an order must call
 * this. The pipeline is the only writer of the `cancelled` transition, so that is
 * the place to look for callers." Both halves were false, and the second made the
 * first unenforceable. `order-pipeline.ts` writes NOTHING — its own header says
 * "Everything here is PURE: no database, no network, no clock"; it is a decision
 * table. An author following that pointer found no callers to check, which is
 * exactly how two of the three real cancel paths (the bulk action in
 * admin-orders.ts, and the status dropdown's `update_status` branch) came to
 * write `cancelled` without ever returning the stock.
 *
 * So this is no longer something a caller has to remember. The sole writer of
 * `fulfillment_status` — `setOrderFulfillmentStatus` in shippo/service.ts — calls
 * this itself, which makes "every path that cancels returns the stock" true by
 * construction. Add a new cancel path and it inherits the behaviour; you do not
 * need to find this file at all.
 *
 * It stays exported and idempotent (behind the `inventory_restocked_at` claim) so
 * a caller that also asks explicitly is a no-op rather than a double-return.
 */

export type CancellationInventoryAction =
  /** Paid order: units were decremented and have been returned. */
  | "restocked"
  /** Unpaid order: the still-active hold was released. */
  | "released"
  /** A cancel or refund already returned this order's stock. */
  | "already_returned"
  | "no_items"
  | "order_not_found"
  /**
   * The order could not be read, or the exactly-once restock claim could not be
   * evaluated. Nothing was changed and nothing else will change it — this is a
   * call for a human, never a quiet success.
   */
  | "unavailable";

export interface CancellationInventoryOutcome {
  action: CancellationInventoryAction;
}

export async function returnInventoryForCancelledOrder(
  orderId: string,
  options?: {
    /**
     * Who the ledger books the restock to. Every caller today is the admin
     * cancel path (setOrderFulfillmentStatus, from the order route and the bulk
     * action), so that is the default — it used to fall through to the
     * webhook's actor and the ledger said "payment_webhook" for a human's click.
     */
    actor?: string;
  },
): Promise<CancellationInventoryOutcome> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, inventory_committed_at, order_items(product_id, quantity)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    // Do NOT guess. Restocking on a failed read could invent stock, and
    // releasing could free a hold a live checkout still needs. Say so loudly
    // instead: the order is already cancelled, so a human can correct the count.
    await recordSystemAlert({
      type: "cancellation_inventory_unresolved",
      severity: "critical",
      message: `Order ${orderId} was cancelled but its inventory could not be returned — the order row could not be read. Check the stock count for this order's items by hand.`,
      context: { orderId, error: String(error.message ?? error) },
    });
    return { action: "unavailable" };
  }

  const order = data as { inventory_committed_at: string | null; order_items?: OrderItemRef[] | null } | null;
  if (!order) return { action: "order_not_found" };

  // Null means this order's units never left the shelf — it was never paid, or a
  // paid lane's decrement did not complete. Either way there is nothing
  // decremented to give back, only a hold to let go of. Restocking on a NULL
  // would invent units.
  if (!order.inventory_committed_at) {
    await releaseInventoryForOrder(orderId);
    return { action: "released" };
  }

  const items = (order.order_items ?? []) as OrderItemRef[];
  if (items.length === 0) return { action: "no_items" };

  // Exactly-once, shared with the webhook refund path.
  const claim = await claimInventoryRestock(orderId);

  if (claim === "unavailable") {
    // NOT "already_returned". Nothing returned these units and nothing will:
    // the claim column is missing or unreadable, so the exactly-once guard
    // cannot be honoured and restocking anyway could double-return them. Same
    // rule as the failed read above — do not guess, say so loudly.
    await recordSystemAlert({
      type: "cancellation_inventory_unresolved",
      severity: "critical",
      message: `Order ${orderId} was cancelled but its inventory could not be returned — the restock claim could not be evaluated. Check the stock count for this order's items by hand.`,
      context: { orderId, stage: "claim" },
    });
    return { action: "unavailable" };
  }

  if (claim === "already_claimed") {
    return { action: "already_returned" };
  }

  await restockInventoryForOrder(items, orderId, options?.actor ?? INVENTORY_ACTOR_ADMIN_CANCELLATION);
  return { action: "restocked" };
}
