import { supabaseAdmin } from "@/lib/supabase-server";
import { invalidateCatalogCache } from "@/lib/catalog-cache";

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

/** What one decrement pass actually managed to do. */
export interface InventoryDecrementResult {
  /** Distinct stock lines this order asked to move. */
  attempted: number;
  /**
   * Lines whose RPC failed outright. Stock did not move for these.
   *
   * COUNTED SEPARATELY FROM `errors`, which is capped. This was
   * `failed: errors.length` against a list that stops growing at 5, so an order
   * with six or more failing lines reported `failed: 5` — understating the
   * damage in the operator alert and in every caller that reasons about
   * "how much of this order moved".
   */
  failed: number;
  /** First few failure messages, for the operator alert. */
  errors: string[];
}

// Commit stock for a newly-paid order. Best-effort per line: a decrement that
// can't apply (untracked item, or a stock number that would go negative) is a
// no-op, and a single failing line is logged and never strands the paid order.
//
// THE FAILURE IS THE RETURN VALUE, NOT AN EXCEPTION.
//
// This returned `Promise<void>` and swallowed every per-line error, so the
// callers' `catch` blocks around it — and the alert and re-throw inside them —
// were unreachable code. In the real failure (the reservation RPC unavailable,
// then adjust_inventory_on_sale erroring on every line) nothing threw, no
// operator alert fired, and the manual lane wrote its paid_side_effects_at
// latch on stock that never moved — so a later cancel "restocked" units that
// were never removed, inventing stock and overselling. Reporting the outcome
// lets the caller tell "the shelf moved" from "nothing happened".
export async function decrementInventoryForOrder(items: OrderItemRef[]): Promise<InventoryDecrementResult> {
  const adjustments = planInventoryAdjustments(items);
  const errors: string[] = [];
  let failed = 0;
  for (const adjustment of adjustments) {
    try {
      await applyInventoryDelta(adjustment, -adjustment.quantity);
    } catch (error) {
      failed += 1;
      console.error("Unable to decrement inventory for", adjustment, error);
      if (errors.length < 5) {
        errors.push(
          `${adjustment.slug}${adjustment.variantId ? `::${adjustment.variantId}` : ""}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  // A sale just changed what is left on the shelf; the cached catalog would
  // keep advertising the pre-sale count for up to a minute otherwise.
  invalidateCatalogCache();
  // NOT-FAILED IS NOT THE SAME AS MOVED. adjust_inventory_on_sale is a no-op for
  // an untracked slug and clamps rather than going negative, so a clean return
  // means "the RPC accepted the line", not "a unit left the shelf". Callers may
  // rely on `failed > 0` meaning something definitely did not move; they may not
  // rely on `failed === 0` meaning every unit did.
  return { attempted: adjustments.length, failed, errors };
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
export async function restockInventoryForOrder(items: OrderItemRef[]): Promise<void> {
  for (const adjustment of planInventoryAdjustments(items)) {
    try {
      await applyInventoryDelta(adjustment, adjustment.quantity);
    } catch (error) {
      console.error("Unable to restock inventory for", adjustment, error);
    }
  }
  invalidateCatalogCache();
}
