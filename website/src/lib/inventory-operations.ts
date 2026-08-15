import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordInventoryTransaction, type InventoryTransactionType } from "@/lib/inventory-ledger";
import { invalidateCatalogCache } from "@/lib/catalog-cache";

// ---------------------------------------------------------------------------
// The stock movements a human makes.
//
// Customer sales are NOT here — those decrement automatically through the
// payment webhook's exactly-once claim, which is correct and untouched. This
// module is for the four things the owner actually does by hand: a supplier
// shipment arriving, a vial going out for testing, something broken, and
// correcting a miscount.
//
// Two rules hold throughout:
//
//   1. EVERY movement writes a ledger row. A quantity with no explanation is
//      how "why does this say 3?" becomes unanswerable a month later.
//   2. RELATIVE, NOT ABSOLUTE. Receiving 40 units adds 40 to whatever is there
//      now. Reading a count, adding in JavaScript, and writing the total back
//      would silently discard any sale that landed in between — and sales land
//      without warning, which is the entire point of them being automatic.
// ---------------------------------------------------------------------------

export interface StockLineRef {
  productId: string;
  /** Set for a variant; null addresses the product row itself. */
  doseId?: string | null;
}

function tableFor(ref: StockLineRef): { table: "products" | "product_doses"; id: string } {
  return ref.doseId
    ? { table: "product_doses", id: ref.doseId }
    : { table: "products", id: ref.productId };
}

interface StockRow {
  inventory_quantity: number | null;
  incoming_quantity: number | null;
  stock_status?: string | null;
  sku?: string | null;
}

async function readStock(ref: StockLineRef): Promise<StockRow | null> {
  const { table, id } = tableFor(ref);
  const { data } = await supabaseAdmin
    .from(table)
    .select("inventory_quantity, incoming_quantity, stock_status, sku")
    .eq("id", id)
    .maybeSingle<StockRow>();
  return data ?? null;
}

export type AdjustResult =
  | { ok: true; quantityBefore: number; quantityAfter: number }
  | { ok: false; message: string };

/**
 * Move available stock by a signed delta.
 *
 * Applied relative to the CURRENT value read inside this call, so a sale that
 * lands between the operator opening the page and pressing the button is not
 * erased. The floor at zero is deliberate: negative sellable stock is
 * meaningless, and clamping is friendlier than refusing a correction outright
 * when someone subtracts more than is there.
 */
export async function adjustStock(input: {
  ref: StockLineRef;
  delta: number;
  type: InventoryTransactionType;
  reason?: string | null;
  actor?: string | null;
  orderId?: string | null;
}): Promise<AdjustResult> {
  const delta = Math.trunc(Number(input.delta));
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, message: "Enter a non-zero whole number of units." };
  }

  const current = await readStock(input.ref);
  if (!current) return { ok: false, message: "That product no longer exists." };

  const before = Math.max(0, Number(current.inventory_quantity ?? 0));
  const after = Math.max(0, before + delta);

  const { table, id } = tableFor(input.ref);

  // Move the STATUS with the quantity, or receiving a shipment does not put the
  // product back on sale.
  //
  // Once tracking is on, resolveStockStatus() only forces "Out of Stock" at a
  // count of zero; above zero it defers to this stored string. So a line that
  // sold out, was stamped "Out of Stock", and then had 10 units received
  // through this function came back with quantity 10 and status "Out of
  // Stock" — invisible on the storefront, unbuyable, with the owner looking at
  // a healthy count in /admin/inventory and no idea why.
  //
  // Only the automatic pair is touched. "Limited" and "Reserved" are set
  // deliberately in the product editor and must survive a stock movement, which
  // is the same rule adjustInventoryLine() follows for manual saves.
  const currentStatus = String(current.stock_status ?? "In Stock");
  const updatePayload: Record<string, unknown> = {
    inventory_quantity: after,
    updated_at: new Date().toISOString(),
  };
  if (currentStatus === "In Stock" || currentStatus === "Out of Stock") {
    updatePayload.stock_status = after > 0 ? "In Stock" : "Out of Stock";
  }

  const { error } = await supabaseAdmin
    .from(table)
    .update(updatePayload)
    .eq("id", id);

  if (error) {
    console.error("Stock adjustment failed", id, error);
    return { ok: false, message: "Could not update the stock count." };
  }

  // Sellable stock moved, so the cached catalog is now wrong. Invalidate here
  // rather than in each caller — receiveShipment, receiveAllIncoming and the
  // operations route all funnel through this one write.
  invalidateCatalogCache();

  await recordInventoryTransaction({
    productId: input.ref.productId,
    doseId: input.ref.doseId ?? null,
    sku: current.sku ?? null,
    type: input.type,
    // The ACTUAL movement, which differs from the requested delta when the
    // clamp bites. Recording the request rather than the effect would make the
    // ledger stop reconciling with the quantity it describes.
    delta: after - before,
    quantityBefore: before,
    quantityAfter: after,
    reason: input.reason ?? null,
    actor: input.actor ?? null,
    orderId: input.orderId ?? null,
  });

  return { ok: true, quantityBefore: before, quantityAfter: after };
}

/**
 * Set the number of units expected from a supplier.
 *
 * Absolute rather than relative, because this is a statement about a purchase
 * order ("40 are coming"), not an event. Re-entering it corrects a mistake
 * instead of doubling the expectation.
 */
export async function setIncoming(input: {
  ref: StockLineRef;
  quantity: number;
  actor?: string | null;
}): Promise<AdjustResult> {
  const quantity = Math.max(0, Math.trunc(Number(input.quantity)));
  if (!Number.isFinite(quantity)) {
    return { ok: false, message: "Incoming must be a whole number of units." };
  }

  const current = await readStock(input.ref);
  if (!current) return { ok: false, message: "That product no longer exists." };

  const { table, id } = tableFor(input.ref);
  const { error } = await supabaseAdmin
    .from(table)
    .update({ incoming_quantity: quantity, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("Incoming update failed", id, error);
    return { ok: false, message: "Could not update the incoming count." };
  }

  // Incoming is surfaced on the storefront as "more on the way", so it is
  // cached alongside the sellable count and has to be dropped with it.
  invalidateCatalogCache();

  // Deliberately NOT ledgered. The ledger records movements of SELLABLE stock;
  // an expectation that has not arrived has moved nothing. Logging it would
  // make the ledger stop summing to the quantity it is supposed to explain.
  return {
    ok: true,
    quantityBefore: Number(current.incoming_quantity ?? 0),
    quantityAfter: quantity,
  };
}

export interface ReceiveLine {
  productId: string;
  doseId?: string | null;
  /** Units to add to available stock. */
  quantity: number;
}

export interface ReceiveResult {
  received: number;
  failed: Array<{ productId: string; doseId: string | null; message: string }>;
}

/**
 * Receive a whole supplier shipment in one action.
 *
 * Sequential on purpose. These are a handful of rows, there is no deadline, and
 * a partial failure that reports exactly which lines did not apply is far more
 * useful than a parallel run whose failures interleave.
 *
 * NOT transactional across lines: if line three fails, lines one and two stay
 * received. That is the right outcome for physical stock — the vials really are
 * on the shelf, and rolling them back to match a database error would make the
 * count wrong in the direction that oversells.
 */
export async function receiveShipment(input: {
  lines: ReceiveLine[];
  reason?: string | null;
  actor?: string | null;
}): Promise<ReceiveResult> {
  const result: ReceiveResult = { received: 0, failed: [] };

  for (const line of input.lines) {
    const quantity = Math.trunc(Number(line.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const ref: StockLineRef = { productId: line.productId, doseId: line.doseId ?? null };
    const adjusted = await adjustStock({
      ref,
      delta: quantity,
      type: "manual_add",
      reason: input.reason ?? "Supplier shipment received",
      actor: input.actor ?? null,
    });

    if (!adjusted.ok) {
      result.failed.push({ productId: line.productId, doseId: line.doseId ?? null, message: adjusted.message });
      continue;
    }

    // Draw the received units down from the expectation, floored at zero so a
    // larger-than-expected delivery does not leave a negative "still coming".
    const current = await readStock(ref);
    const incoming = Math.max(0, Number(current?.incoming_quantity ?? 0) - quantity);
    const { table, id } = tableFor(ref);
    await supabaseAdmin.from(table).update({ incoming_quantity: incoming }).eq("id", id);

    result.received += 1;
  }

  return result;
}

/**
 * Receive everything currently marked incoming on one line.
 *
 * The common case: a box arrives holding exactly what was ordered, and the
 * owner presses one button rather than retyping the number.
 */
export async function receiveAllIncoming(input: {
  ref: StockLineRef;
  actor?: string | null;
}): Promise<AdjustResult> {
  const current = await readStock(input.ref);
  if (!current) return { ok: false, message: "That product no longer exists." };

  const incoming = Math.max(0, Number(current.incoming_quantity ?? 0));
  if (incoming <= 0) {
    return { ok: false, message: "Nothing is marked as incoming for this line." };
  }

  const adjusted = await adjustStock({
    ref: input.ref,
    delta: incoming,
    type: "manual_add",
    reason: "Incoming shipment received",
    actor: input.actor ?? null,
  });
  if (!adjusted.ok) return adjusted;

  const { table, id } = tableFor(input.ref);
  await supabaseAdmin.from(table).update({ incoming_quantity: 0 }).eq("id", id);

  return adjusted;
}
