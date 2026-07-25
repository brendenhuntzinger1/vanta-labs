import { supabaseAdmin } from "@/lib/supabase-server";

// Inventory movement for the PAID path. An order's stock is only ever committed
// when money is actually captured (manual payment approved, or card
// `payment.succeeded`), and restocked when that money is fully returned
// (refund / cancel). All of it goes through one atomic RPC so concurrent orders
// for the last unit of a product can never oversell — see
// `adjust_inventory_on_sale` in deploy-run-once.sql and the concurrency proof in
// scripts/db-integrity-stress.mjs.

export interface OrderItemRef {
  productId?: string | null;
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
    if (!item?.productId || !Number.isFinite(qty) || qty <= 0) {
      continue;
    }
    const { slug, variantId } = parseOrderItemRef(String(item.productId));
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

async function applyInventoryDelta(adjustment: InventoryAdjustment, signedQty: number): Promise<void> {
  const { error } = await supabaseAdmin.rpc("adjust_inventory_on_sale", {
    p_slug: adjustment.slug,
    p_variant_id: adjustment.variantId,
    p_qty: signedQty,
  });
  if (error) {
    throw error;
  }
}

// Commit stock for a newly-paid order. Best-effort per line: a decrement that
// can't apply (untracked item, or a stock number that would go negative) is a
// no-op, and a single failing line is logged and never strands the paid order.
export async function decrementInventoryForOrder(items: OrderItemRef[]): Promise<void> {
  for (const adjustment of planInventoryAdjustments(items)) {
    try {
      await applyInventoryDelta(adjustment, -adjustment.quantity);
    } catch (error) {
      console.error("Unable to decrement inventory for", adjustment, error);
    }
  }
}

// Atomic exactly-once claim for an order's restock. Flips inventory_restocked_at
// NULL -> now and returns true ONLY for the caller that won the flip. Every
// concurrent or duplicate refund event, chargeback, and admin double-click loses
// the claim and must skip restocking — so inventory can never be returned twice
// (which would create phantom stock and feed overselling). Mirrors the
// paid_side_effects_at exactly-once pattern used for the paid side-effects.
//
// Fail-safe: if the claim errors (e.g. the column isn't migrated yet), it
// returns false so the caller does NOT restock. Under-restock (stock stays low)
// is a recoverable inconvenience; double-restock is a money-losing oversell, so
// the safe failure direction is "don't restock". Run the
// add-inventory-restock-claim.sql migration BEFORE deploying this code.
export async function claimInventoryRestock(orderId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ inventory_restocked_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("inventory_restocked_at", null)
    .select("id");
  if (error) {
    console.error("Inventory restock claim failed (skipping restock) for order", orderId, error);
    return false;
  }
  return Boolean(data && data.length > 0);
}

// Return stock when a paid order is fully refunded or canceled — the exact
// inverse of the decrement above, so tracked stock nets back to where it began.
// Gate every call with claimInventoryRestock(orderId) so it runs at most once.
export async function restockInventoryForOrder(items: OrderItemRef[]): Promise<void> {
  for (const adjustment of planInventoryAdjustments(items)) {
    try {
      await applyInventoryDelta(adjustment, adjustment.quantity);
    } catch (error) {
      console.error("Unable to restock inventory for", adjustment, error);
    }
  }
}
