import "server-only";

// One-click replacement shipments for damaged / lost / stolen orders (the
// store-backed Shipping Protection promise). A replacement is a REAL order
// row — so the existing fulfillment queue, tracking emails, packing slips, and
// payout accounting all just work — but a $0 one: the customer is never
// charged, no commission/points/coupons apply, and revenue dashboards see
// $0. It is linked back to the original order for the audit trail.

import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import { decrementInventoryForOrder } from "@/lib/inventory-fulfillment";
import { recordSystemAlert } from "@/lib/monitoring";

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
  /** True when this call found an existing replacement rather than creating one. */
  duplicate?: boolean;
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
  /**
   * One id per intent-to-create, generated when the confirmation dialog opens.
   *
   * THE DUPLICATE GUARD. Without it every call minted a fresh random order id,
   * so a double-click, a retried fetch or a second tab produced TWO replacement
   * orders — two parcels, two labels, two lots of postage, and stock deducted
   * twice for one apology.
   *
   * With it the new order id is DERIVED from (original order + request id), so
   * the second identical request collides with the primary key on orders and is
   * refused by the database rather than by a check that can race. Two genuine
   * replacements mean two dialogs, two request ids, two orders — which still
   * works exactly as it should.
   */
  requestId?: string | null;
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

  // Deterministic when a requestId is supplied; random otherwise, so an older
  // caller that has not been updated still works (it simply loses the guard).
  const orderId = input.requestId
    ? `order-rp-${createHash("sha256")
        .update(`${input.originalOrderId}::${input.requestId}`)
        .digest("hex")
        .slice(0, 24)}`
    : `order-${randomUUID()}`;

  // Cheap pre-check so a genuine duplicate returns the FIRST replacement
  // instead of an error the operator has to interpret. The primary key below is
  // still the real guarantee — this only makes the common case read nicely.
  if (input.requestId) {
    const { data: existing } = await supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_email, customer_name")
      .eq("order_id", orderId)
      .maybeSingle();
    if (existing) {
      const { data: existingItems } = await supabaseAdmin
        .from("order_items")
        .select("product_name, product_id, quantity")
        .eq("order_id", orderId);
      return {
        orderId: String(existing.order_id),
        orderNumber: String(existing.order_number),
        items: (existingItems ?? []).map((item) => ({
          name: String(item.product_name ?? item.product_id ?? "Item"),
          quantity: Number(item.quantity ?? 1),
        })),
        customerEmail: existing.customer_email ? String(existing.customer_email) : null,
        customerName: existing.customer_name ? String(existing.customer_name) : null,
        duplicate: true,
      };
    }
  }
  const orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  // $0 order: every money/promo field zeroed or nulled; customer + shipping
  // address copied verbatim so the replacement ships to the same destination.
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
    // The apartment line. Missing here meant every replacement shipped to the
    // building and not the unit -- a redelivery on a parcel already sent to
    // apologise for a delivery that went wrong.
    shipping_address_2: original.shipping_address_2 ?? null,
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
      // baseOrderRow has no state and no phone, and carriers reject a US
      // shipment without a state. Retry with them re-attached rather than
      // falling all the way back to a row that cannot ship.
      const { replacement_of: _a, replacement_reason: _b, shipping_address_2: _c, ...retryRow } = fullOrderRow;
      insertError = (await supabaseAdmin.from("orders").insert(retryRow)).error;
      if (insertError) {
        insertError = (await supabaseAdmin.from("orders").insert(baseOrderRow)).error;
      }
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
  //
  // Still non-fatal: the parcel is going out either way, and refusing to create
  // the reship over a counter would leave the customer without their apology.
  // But it is NO LONGER SILENT. A swallowed failure here is precisely how
  // database stock drifts above the shelf — the units leave, nothing records
  // it, and the discrepancy only surfaces at a physical count months later.
  try {
    await decrementInventoryForOrder(
      replacementItems.map((item) => ({ product_id: item.product_id, quantity: item.quantity })) as Array<{ product_id?: string | null; quantity?: number | null }>,
    );
  } catch (error) {
    await recordSystemAlert({
      type: "replacement_inventory_not_decremented",
      severity: "critical",
      message:
        `Replacement ${orderNumber} shipped stock that was NOT deducted from inventory. ` +
        `Adjust it by hand or the count will read high.`,
      context: {
        replacementOrderId: orderId,
        originalOrderId: input.originalOrderId,
        items: replacementItems.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
        reason: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
  }

  // The replacement order lands in the admin fulfillment queue and is shipped
  // in-house. A replacement carries the customer's address like any other
  // order, so nothing about it may be transmitted to an outside provider.

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
