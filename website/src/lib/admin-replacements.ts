import "server-only";

// One-click replacement shipments for damaged / lost / stolen orders (the
// store-backed Shipping Protection promise). A replacement is a REAL order
// row — so the existing 3PL pipeline, tracking emails, packing slips, and
// payout accounting all just work — but a $0 one: the customer is never
// charged, no commission/points/coupons apply, and revenue dashboards see
// $0. It is linked back to the original order for the audit trail.

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import { transmitOrderToFulfillment } from "@/lib/fulfillment/service";
import { decrementInventoryForOrder } from "@/lib/inventory-fulfillment";

export type ReplacementReason = "damaged" | "lost" | "stolen" | "other";

export interface ReplacementSelection {
  /** order_items.id of the line being replaced. */
  itemId: string | number;
  /** Units to reship (clamped to 1..original quantity). */
  quantity: number;
}

export interface ReplacementResult {
  orderId: string;
  orderNumber: string;
  items: Array<{ name: string; quantity: number }>;
  customerEmail: string | null;
  customerName: string | null;
}

type OriginalItem = Record<string, unknown> & {
  id: string | number;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | null;
};

// Build the replacement's item rows from the original's, honoring an optional
// per-line selection. Exported for unit tests (pure).
export function buildReplacementItems(
  originalItems: OriginalItem[],
  selections?: ReplacementSelection[] | null,
): OriginalItem[] {
  if (!selections || selections.length === 0) {
    return originalItems.map((item) => ({ ...item }));
  }
  const byId = new Map(originalItems.map((item) => [String(item.id), item]));
  const rows: OriginalItem[] = [];
  for (const selection of selections) {
    const original = byId.get(String(selection.itemId));
    if (!original) continue;
    const maxQty = Math.max(1, Number(original.quantity ?? 1));
    const qty = Math.min(maxQty, Math.max(1, Math.floor(Number(selection.quantity) || 1)));
    rows.push({ ...original, quantity: qty });
  }
  return rows;
}

export async function createReplacementOrder(input: {
  originalOrderId: string;
  reason: ReplacementReason;
  note?: string | null;
  selections?: ReplacementSelection[] | null;
}): Promise<ReplacementResult> {
  const { data: original, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_id", input.originalOrderId)
    .maybeSingle();

  if (error) throw error;
  if (!original) throw new Error("Original order not found");

  const status = String(original.payment_status ?? "").toLowerCase();
  if (!PAID_ORDER_STATUSES.has(status) && status !== "partially_refunded") {
    throw new Error("Replacements can only be sent for paid orders.");
  }

  const originalItems = (original.order_items ?? []) as OriginalItem[];
  const replacementItems = buildReplacementItems(originalItems, input.selections);
  if (replacementItems.length === 0) {
    throw new Error("Select at least one item to replace.");
  }

  const orderId = `order-${randomUUID()}`;
  const orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  // $0 order: every money/promo field zeroed or nulled; customer + shipping
  // address copied verbatim so the 3PL ships to the same destination.
  const baseOrderRow: Record<string, unknown> = {
    order_id: orderId,
    order_number: orderNumber,
    payment_id: null,
    payment_method: "replacement",
    card_processing_fee: 0,
    card_processing_fee_percent: 0,
    customer_email: original.customer_email,
    customer_name: original.customer_name,
    shipping_address: original.shipping_address,
    city: original.city,
    postal_code: original.postal_code,
    country: original.country,
    currency: original.currency ?? "USD",
    subtotal: 0,
    shipping_amount: 0,
    handling_fee: 0,
    tax_amount: 0,
    discount_amount: 0,
    priority: true,
    amount_paid: 0,
    referral_code: null,
    ambassador_id: null,
    coupon_code: null,
    customer_user_id: original.customer_user_id ?? null,
    points_redeemed: 0,
    store_credit_redeemed_cents: 0,
    order_type: "replacement",
    payment_status: "paid",
    paid_at: now,
    fulfillment_status: "awaiting_fulfillment",
    created_at: now,
    updated_at: now,
  };

  // Newer/optional columns, inserted with the same graceful missing-column
  // fallback used elsewhere so a replacement never fails over a pending
  // migration (replacement-orders.sql adds the linkage columns).
  const fullOrderRow: Record<string, unknown> = {
    ...baseOrderRow,
    state: original.state ?? null,
    phone: original.phone ?? null,
    replacement_of: original.order_id,
    replacement_reason: input.reason + (input.note ? ` — ${String(input.note).slice(0, 300)}` : ""),
  };

  let insertError = (await supabaseAdmin.from("orders").insert(fullOrderRow)).error;
  if (insertError) {
    const message = String(insertError.message ?? "").toLowerCase();
    const looksLikeMissingColumn = insertError.code === "PGRST204"
      || message.includes("does not exist")
      || message.includes("schema cache")
      || message.includes("could not find");
    if (looksLikeMissingColumn) {
      insertError = (await supabaseAdmin.from("orders").insert(baseOrderRow)).error;
    }
  }
  if (insertError) {
    throw new Error(`Unable to create replacement order: ${insertError.message}`);
  }

  // Copy the selected item rows onto the new order. Unit cost snapshots are
  // preserved so profit reporting shows the true cost of the replacement
  // (cost with $0 revenue — an accurate picture of what the claim cost).
  const itemRows = replacementItems.map((item) => {
    const row: Record<string, unknown> = { ...item, order_id: orderId };
    delete row.id;
    delete row.created_at;
    return row;
  });
  const { error: itemsError } = await supabaseAdmin.from("order_items").insert(itemRows);
  if (itemsError) {
    // Roll back the header so we never leave an empty shippable order behind.
    await supabaseAdmin.from("orders").delete().eq("order_id", orderId);
    throw new Error(`Unable to create replacement items: ${itemsError.message}`);
  }

  // Real stock leaves the warehouse for a replacement — keep counts honest.
  // Best-effort: an inventory hiccup must not block the reshipment.
  try {
    await decrementInventoryForOrder(
      replacementItems.map((item) => ({ product_id: item.product_id, quantity: item.quantity })) as Array<{ product_id?: string | null; quantity?: number | null }>,
    );
  } catch {
    /* non-fatal */
  }

  // Queue/transmit to the 3PL through the existing pipeline (no-op when the
  // 3PL integration isn't configured — the order still appears in the
  // fulfillment queue for manual handling).
  try {
    await transmitOrderToFulfillment(orderId);
  } catch {
    /* non-fatal — the order remains in the fulfillment queue */
  }

  return {
    orderId,
    orderNumber,
    items: replacementItems.map((item) => ({
      name: String(item.product_name ?? item.product_id ?? "Item"),
      quantity: Number(item.quantity ?? 1),
    })),
    customerEmail: original.customer_email ? String(original.customer_email) : null,
    customerName: original.customer_name ? String(original.customer_name) : null,
  };
}
