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

/** The key an adjustment shares with the reservation row for the same line. */
function adjustmentKey(line: { slug: string; variantId: string | null }): string {
  return `${line.slug}::${line.variantId ?? ""}`;
}

/**
 * The order lines a reservation finalize did NOT move (F4).
 *
 * A reservation can be PARTIAL. `reserveInventoryForOrder` holds line by line
 * and gives up the moment one line's RPC fails — with the earlier lines already
 * held — so an order can reach payment holding line 1 and nothing for line 2.
 * The paid lanes used to fall back to the legacy decrement only when the
 * finalize moved NOTHING, so that order finalized one line, reported success,
 * and line 2 was sold with no stock movement at all.
 *
 * Matching is by slug + variant, because that is the granularity the holds and
 * the inventory rows share; the variant lives inside `product_id` as
 * `"<slug>::<dose>"`, which parseOrderItemRef splits. A line whose product_id is
 * unusable is returned as unmoved: the decrement no-ops on it safely, whereas
 * dropping it would hide a real sale.
 *
 * Pure + testable, and deliberately NOT quantity-aware — a hold is taken for the
 * whole line or not at all, so a line that finalized is done.
 */
export function itemsNotFinalized(
  items: OrderItemRef[],
  finalizedLines: Array<{ slug: string; variantId: string | null }>,
): OrderItemRef[] {
  const moved = new Set(finalizedLines.map(adjustmentKey));
  return (items ?? []).filter((item) => {
    const productId = item?.productId ?? item?.product_id;
    if (!productId) return true;
    return !moved.has(adjustmentKey(parseOrderItemRef(String(productId))));
  });
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
//
// `orderId` is carried through to the movement ledger (see applyInventoryDelta)
// so a finalized sale is attributable; it stays optional because the legacy
// callers that have no order in hand still need this path.
/**
 * Units of one line that no OTHER order is holding.
 *
 * A LATE PAYMENT MUST NOT TAKE ANOTHER CHECKOUT'S UNITS. The fallback decrement
 * runs when this order's own hold is gone (it expired before the customer paid,
 * or the reservation RPC was unavailable). adjust_inventory_on_sale only checks
 * `inventory_quantity + delta >= 0` — it knows nothing about reserved_quantity —
 * so it happily sold the last unit out from under an order that was holding it.
 * That order's later finalize then clamped at 0 and reported success: two paid
 * orders, one vial. This reads the row's on-hand and reserved counts, adds back
 * whatever THIS order still holds (a degraded finalize leaves its own hold
 * active), and hands the caller the number that is genuinely free to sell.
 *
 * NULL when it cannot be answered. A read failure must not decide a sale either
 * way, so the caller keeps today's behaviour for that line.
 */
async function readUnitsFreeForOrder(
  adjustment: InventoryAdjustment,
  orderId: string | null | undefined,
): Promise<{ free: number; heldByOthers: number } | null> {
  try {
    const row = adjustment.variantId
      ? await supabaseAdmin
          .from("product_doses")
          .select("inventory_quantity, reserved_quantity")
          .eq("id", adjustment.variantId)
          .maybeSingle<{ inventory_quantity: number | null; reserved_quantity: number | null }>()
      : await supabaseAdmin
          .from("products")
          .select("inventory_quantity, reserved_quantity")
          .eq("slug", adjustment.slug)
          .maybeSingle<{ inventory_quantity: number | null; reserved_quantity: number | null }>();
    if (row.error || !row.data) return null;
    const onHand = Number(row.data.inventory_quantity ?? 0);
    const reserved = Math.max(0, Number(row.data.reserved_quantity ?? 0));

    let ownHold = 0;
    if (orderId) {
      let query = supabaseAdmin
        .from("inventory_reservations")
        .select("quantity")
        .eq("order_id", orderId)
        .eq("status", "active")
        .eq("slug", adjustment.slug);
      query = adjustment.variantId ? query.eq("variant_id", adjustment.variantId) : query.is("variant_id", null);
      const { data: holds, error } = await query;
      if (error) return null;
      for (const hold of (holds ?? []) as Array<{ quantity?: number | null }>) {
        ownHold += Math.max(0, Math.trunc(Number(hold.quantity ?? 0)));
      }
    }

    const heldByOthers = Math.max(0, reserved - ownHold);
    return { free: onHand - heldByOthers, heldByOthers };
  } catch {
    return null;
  }
}

export async function decrementInventoryForOrder(items: OrderItemRef[], orderId?: string | null): Promise<InventoryDecrementResult> {
  const adjustments = planInventoryAdjustments(items);
  const errors: string[] = [];
  let failed = 0;
  for (const adjustment of adjustments) {
    try {
      // Refuse, rather than take, units another checkout is holding. Only a
      // line that other orders actually hold can trip this, so an untracked or
      // unreserved row behaves exactly as before.
      const room = await readUnitsFreeForOrder(adjustment, orderId);
      if (room && room.heldByOthers > 0 && room.free < adjustment.quantity) {
        const detail = `${adjustment.slug}${adjustment.variantId ? `::${adjustment.variantId}` : ""}`;
        await recordSystemAlert({
          type: "inventory_units_held_by_other_orders",
          severity: "critical",
          message:
            `Order ${orderId ?? "(unknown)"} paid for ${adjustment.quantity} x ${detail} but only ${Math.max(0, room.free)} `
            + `unit(s) are free — ${room.heldByOthers} are held by other checkouts in flight. Stock was NOT decremented `
            + "so those checkouts keep their units. Fulfil this order from incoming stock or refund it, then correct the count by hand.",
          context: { orderId: orderId ?? null, slug: adjustment.slug, variantId: adjustment.variantId, quantity: adjustment.quantity, free: room.free, heldByOthers: room.heldByOthers },
        }).catch(() => {});
        throw new Error(`${room.heldByOthers} unit(s) of ${detail} are held by other checkouts; only ${Math.max(0, room.free)} free`);
      }
      await applyInventoryDelta(adjustment, -adjustment.quantity, {
        orderId,
        type: "order_completed",
        reason: orderId ? `Sold on ${orderId}` : "Sold",
      });
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
