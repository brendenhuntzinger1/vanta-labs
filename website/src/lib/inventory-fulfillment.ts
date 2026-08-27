import { supabaseAdmin } from "@/lib/supabase-server";
import { invalidateCatalogCache } from "@/lib/catalog-cache";
import { recordInventoryTransaction, type InventoryTransactionType } from "@/lib/inventory-ledger";
import { recordSystemAlert } from "@/lib/monitoring";

// Inventory movement for the PAID path. An order's stock is only ever committed
// when money is actually captured (manual payment approved, or card
// `payment.succeeded`), and restocked when that money is fully returned
// (refund / cancel). All of it goes through one atomic RPC so concurrent orders
// for the last unit of a product can never oversell — see
// `adjust_inventory_on_sale` in deploy-run-once.sql and the concurrency proof in
// scripts/db-integrity-stress.mjs.

export interface OrderItemRef {
  productId?: string | null;
  /** Raw DB rows use snake_case — accepted directly so callers passing
   *  order_items rows (payment-webhook, replacements) actually decrement
   *  stock instead of silently no-opping on the key-name mismatch. */
  product_id?: string | null;
  quantity?: number | null;
}

export interface InventoryAdjustment {
  slug: string;
  variantId: string | null;
  quantity: number;
}

// An order item's `product_id` is the cart line id: either a bare product slug
// ("bpc-157-10mg") or a slug + dose/variant ("bpc-157-10mg::<dose-uuid>"). Split
// it back into the parts the inventory tables are keyed on. Pure + testable.
export function parseOrderItemRef(productId: string): { slug: string; variantId: string | null } {
  const [slug, variantId] = String(productId).split("::");
  return {
    slug: slug ?? "",
    variantId: variantId && variantId.length > 0 ? variantId : null,
  };
}

// Collapse a list of order-item rows into one positive quantity per distinct
// product/variant, dropping anything without a real slug or a positive integer
// quantity. Summing here means a cart that happens to list the same variant on
// two lines still moves the correct total exactly once. Pure + testable.
export function planInventoryAdjustments(items: OrderItemRef[]): InventoryAdjustment[] {
  const byKey = new Map<string, InventoryAdjustment>();
  for (const item of items ?? []) {
    const qty = Math.trunc(Number(item?.quantity ?? 0));
    const productId = item?.productId ?? item?.product_id;
    if (!productId || !Number.isFinite(qty) || qty <= 0) {
      continue;
    }
    const { slug, variantId } = parseOrderItemRef(String(productId));
    if (!slug) {
      continue;
    }
    const key = `${slug}::${variantId ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += qty;
    } else {
      byKey.set(key, { slug, variantId, quantity: qty });
    }
  }
  return [...byKey.values()];
}

// Read the quantity the RPC just left behind, so the ledger row can carry real
// before/after numbers instead of two nulls. Dose-authoritative for a dosed
// line, exactly like the RPC itself. Best-effort: a failed read costs the
// ledger its numbers, never the movement.
//
// EXPORTED so the reservation-finalize path (inventory-reservation.ts) records
// its movements the same way this one does. Both paths commit stock for a paid
// order; a ledger whose numbers meant different things depending on which path
// ran would be worse than no ledger.
export async function readQuantityAfter(adjustment: InventoryAdjustment): Promise<{ after: number | null; productId: string | null }> {
  try {
    if (adjustment.variantId) {
      const { data } = await supabaseAdmin
        .from("product_doses")
        .select("inventory_quantity, product_id")
        .eq("id", adjustment.variantId)
        .maybeSingle<{ inventory_quantity: number | null; product_id: string | null }>();
      if (!data) return { after: null, productId: null };
      return { after: Number(data.inventory_quantity ?? 0), productId: data.product_id ? String(data.product_id) : null };
    }
    const { data } = await supabaseAdmin
      .from("products")
      .select("inventory_quantity, id")
      .eq("slug", adjustment.slug)
      .maybeSingle<{ inventory_quantity: number | null; id: string | null }>();
    if (!data) return { after: null, productId: null };
    return { after: Number(data.inventory_quantity ?? 0), productId: data.id ? String(data.id) : null };
  } catch {
    return { after: null, productId: null };
  }
}

/**
 * Move stock for one order line and WRITE DOWN THAT IT MOVED.
 *
 * Two things here are load-bearing and were both missing:
 *
 * 1. `adjust_inventory_on_sale` returns a boolean. It is `false` when the row
 *    did not move — no such dose/slug, or the `inventory_quantity + p_qty >= 0`
 *    guard refused a decrement that would go negative. That was discarded, so a
 *    paid order whose stock could NOT be committed looked identical to one that
 *    committed cleanly.
 *
 * 2. Nothing recorded order-driven movements in `inventory_transactions`. Only
 *    the admin's own manual edits were logged, so the ledger showed a shelf that
 *    only ever moved when a human touched it. On 2026-08-27 the operator, seeing
 *    no sale row for the store's first real customer order, manually decremented
 *    BAC Water a SECOND time — the automatic decrement had already run. An
 *    invisible movement is how a correct system produces a wrong count.
 */
async function applyInventoryDelta(
  adjustment: InventoryAdjustment,
  signedQty: number,
  context: { orderId?: string | null; type: InventoryTransactionType; reason: string },
): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("adjust_inventory_on_sale", {
    p_slug: adjustment.slug,
    p_variant_id: adjustment.variantId,
    p_qty: signedQty,
  });
  if (error) {
    throw error;
  }

  // `false` means the shelf did not move. For a decrement that is a sale we
  // could not take stock for — the single most important inventory event there
  // is, and previously silent.
  if (data === false) {
    const detail = `${adjustment.slug}${adjustment.variantId ? `::${adjustment.variantId}` : ""} x${Math.abs(signedQty)}`;
    console.error("Inventory movement did not apply", detail, context);
    await recordSystemAlert({
      type: signedQty < 0 ? "inventory_decrement_not_applied" : "inventory_restock_not_applied",
      severity: signedQty < 0 ? "critical" : "warning",
      message:
        signedQty < 0
          ? `Sold ${detail} but stock did not move — the row is untracked, missing, or already at 0. Physical count and recorded count now disagree.`
          : `Could not return ${detail} to stock.`,
      context: { orderId: context.orderId ?? null, slug: adjustment.slug, variantId: adjustment.variantId, quantity: signedQty },
    });
    return;
  }

  const { after, productId } = await readQuantityAfter(adjustment);
  await recordInventoryTransaction({
    productId: productId ?? adjustment.slug,
    doseId: adjustment.variantId,
    type: context.type,
    delta: signedQty,
    quantityBefore: after === null ? null : after - signedQty,
    quantityAfter: after,
    reason: context.reason,
    actor: "payment_webhook",
    orderId: context.orderId ?? null,
  });
}

// Commit stock for a newly-paid order. Best-effort per line: a decrement that
// can't apply (untracked item, or a stock number that would go negative) is a
// no-op, and a single failing line is logged and never strands the paid order.
export async function decrementInventoryForOrder(items: OrderItemRef[], orderId?: string | null): Promise<void> {
  for (const adjustment of planInventoryAdjustments(items)) {
    try {
      await applyInventoryDelta(adjustment, -adjustment.quantity, {
        orderId,
        type: "order_completed",
        reason: orderId ? `Sold on ${orderId}` : "Sold",
      });
    } catch (error) {
      console.error("Unable to decrement inventory for", adjustment, error);
    }
  }
  // A sale just changed what is left on the shelf; the cached catalog would
  // keep advertising the pre-sale count for up to a minute otherwise.
  invalidateCatalogCache();
}

// Atomic exactly-once claim for an order's restock. Flips inventory_restocked_at
// NULL -> now and returns true ONLY for the caller that won the flip. Every
// concurrent or duplicate refund event, chargeback, and admin double-click loses
// the claim and must skip restocking — so inventory can never be returned twice
// (which would create phantom stock and feed overselling). Mirrors the
// paid_side_effects_at exactly-once pattern used for the paid side-effects.
//
// Fail-safe: if the claim errors (e.g. the column isn't migrated yet), it does
// NOT restock. Under-restock (stock stays low) is a recoverable inconvenience;
// double-restock is a money-losing oversell, so the safe failure direction is
// "don't restock". Run the add-inventory-restock-claim.sql migration BEFORE
// deploying this code.
//
// THREE OUTCOMES, NOT TWO (review finding 2). This returned a bare boolean, and
// `false` meant both "somebody else already restocked this order" and "the claim
// could not be evaluated at all". Those are opposite facts: the first says the
// units are safely back, the second says they are gone and nothing is coming for
// them. orders.inventory_restocked_at DOES NOT EXIST in production as of
// 2026-08-26, so today every call returns the failure — and the cancel path
// reported it to the operator as "already returned". A failure wearing a
// success's clothes is how the whole K-17 return path came to be inert without
// anyone noticing.
export type InventoryRestockClaim =
  /** This caller won the flip and MUST restock. */
  | "claimed"
  /** A refund, chargeback or earlier cancel already returned these units. */
  | "already_claimed"
  /** The claim could not be evaluated. Nothing was restocked and nothing will be. */
  | "unavailable";

export async function claimInventoryRestock(orderId: string): Promise<InventoryRestockClaim> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ inventory_restocked_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("inventory_restocked_at", null)
    .select("id");
  if (error) {
    console.error("Inventory restock claim failed (skipping restock) for order", orderId, error);
    return "unavailable";
  }
  return data && data.length > 0 ? "claimed" : "already_claimed";
}

// Return stock when a paid order is fully refunded or canceled — the exact
// inverse of the decrement above, so tracked stock nets back to where it began.
// Gate every call with claimInventoryRestock(orderId) so it runs at most once.
export async function restockInventoryForOrder(items: OrderItemRef[], orderId?: string | null): Promise<void> {
  for (const adjustment of planInventoryAdjustments(items)) {
    try {
      await applyInventoryDelta(adjustment, adjustment.quantity, {
        orderId,
        type: "order_canceled",
        reason: orderId ? `Returned to stock from ${orderId}` : "Returned to stock",
      });
    } catch (error) {
      console.error("Unable to restock inventory for", adjustment, error);
    }
  }
  invalidateCatalogCache();
}
