import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// The inventory ledger: every change to a stock level, and why.
//
// Without it, "why does this product say 3 when I counted 5?" is unanswerable.
// The current quantity is a running total with no history, so a miscount, a
// double-decrement, or an adjustment somebody forgot making are all
// indistinguishable from each other after the fact.
//
// APPEND-ONLY, deliberately. Rows are never updated or deleted -- a ledger you
// can edit answers no questions. A mistaken entry is corrected by writing a
// compensating one, which leaves both visible.
//
// Recording is best-effort at every call site: a ledger write must never fail
// the stock movement it describes. Losing a history row is a gap in an audit
// trail; failing the movement means overselling or a customer's refund not
// restocking.
// ---------------------------------------------------------------------------

export type InventoryTransactionType =
  | "manual_add"
  | "manual_subtract"
  | "manual_set"
  | "order_reserved"
  | "order_completed"
  | "order_canceled"
  | "refund_restock"
  | "damaged"
  | "lost"
  | "correction";

export const INVENTORY_TRANSACTION_LABELS: Record<InventoryTransactionType, string> = {
  manual_add: "Manual addition",
  manual_subtract: "Manual subtraction",
  manual_set: "Set exact quantity",
  order_reserved: "Reserved for order",
  order_completed: "Order completed",
  order_canceled: "Order canceled",
  refund_restock: "Refund restock",
  damaged: "Damaged",
  lost: "Lost",
  correction: "Administrative correction",
};

export interface InventoryLedgerEntry {
  productId: string;
  doseId?: string | null;
  sku?: string | null;
  type: InventoryTransactionType;
  /** Signed change. Negative removes stock. */
  delta: number;
  quantityBefore: number | null;
  quantityAfter: number | null;
  reason?: string | null;
  /** Admin username, or a system marker like "payment_webhook". */
  actor?: string | null;
  orderId?: string | null;
}

/**
 * Append one entry. Never throws.
 *
 * The caller has usually already moved the stock by the time this runs, so an
 * exception here would fail an operation that already succeeded -- turning a
 * missing audit row into a misleading error.
 */
export async function recordInventoryTransaction(entry: InventoryLedgerEntry): Promise<void> {
  try {
    await supabaseAdmin.from("inventory_transactions").insert({
      product_id: entry.productId,
      dose_id: entry.doseId ?? null,
      sku: entry.sku ?? null,
      transaction_type: entry.type,
      delta: Math.trunc(entry.delta),
      quantity_before: entry.quantityBefore,
      quantity_after: entry.quantityAfter,
      reason: entry.reason ? String(entry.reason).slice(0, 500) : null,
      actor: entry.actor ?? null,
      order_id: entry.orderId ?? null,
    });
  } catch (error) {
    console.error("Unable to record inventory transaction", entry.productId, error);
  }
}

export interface InventoryTransactionRow {
  id: string;
  productId: string;
  doseId: string | null;
  sku: string | null;
  productName: string | null;
  type: InventoryTransactionType;
  typeLabel: string;
  delta: number;
  quantityBefore: number | null;
  quantityAfter: number | null;
  reason: string | null;
  actor: string | null;
  orderId: string | null;
  createdAt: string;
}

function normalizeType(value: unknown): InventoryTransactionType {
  const raw = String(value ?? "correction");
  return (raw in INVENTORY_TRANSACTION_LABELS ? raw : "correction") as InventoryTransactionType;
}

export interface InventoryHistoryFilters {
  productId?: string;
  doseId?: string;
  type?: InventoryTransactionType;
  limit?: number;
}

export async function getInventoryHistory(
  filters: InventoryHistoryFilters = {},
): Promise<InventoryTransactionRow[]> {
  // Capped: the ledger grows without bound, and an uncapped read would
  // eventually time out the admin page rather than merely being slow.
  const limit = Math.min(1000, Math.max(1, Math.trunc(filters.limit ?? 200)));

  let query = supabaseAdmin
    .from("inventory_transactions")
    .select("id, product_id, dose_id, sku, transaction_type, delta, quantity_before, quantity_after, reason, actor, order_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (filters.productId) query = query.eq("product_id", filters.productId);
  if (filters.doseId) query = query.eq("dose_id", filters.doseId);
  if (filters.type) query = query.eq("transaction_type", filters.type);

  const { data, error } = await query;
  if (error) {
    // The ledger is diagnostic. If it cannot be read, the admin screen should
    // still render its inventory rather than fail wholesale.
    console.error("Unable to read inventory history", error);
    return [];
  }

  const rows = data ?? [];
  const productIds = [...new Set(rows.map((row) => String(row.product_id)).filter(Boolean))];
  const names = new Map<string, string>();
  if (productIds.length > 0) {
    const { data: products } = await supabaseAdmin.from("products").select("id, name").in("id", productIds);
    for (const product of products ?? []) names.set(String(product.id), String(product.name ?? ""));
  }

  return rows.map((row) => {
    const type = normalizeType(row.transaction_type);
    return {
      id: String(row.id),
      productId: String(row.product_id),
      doseId: row.dose_id ? String(row.dose_id) : null,
      sku: row.sku ? String(row.sku) : null,
      productName: names.get(String(row.product_id)) ?? null,
      type,
      typeLabel: INVENTORY_TRANSACTION_LABELS[type],
      delta: Number(row.delta ?? 0),
      quantityBefore: row.quantity_before === null ? null : Number(row.quantity_before),
      quantityAfter: row.quantity_after === null ? null : Number(row.quantity_after),
      reason: row.reason ? String(row.reason) : null,
      actor: row.actor ? String(row.actor) : null,
      orderId: row.order_id ? String(row.order_id) : null,
      createdAt: String(row.created_at),
    };
  });
}

/**
 * Quote a value for CSV.
 *
 * The leading-symbol guard is not cosmetic: a value starting with =, +, - or @
 * is executed as a formula when the file is opened in Excel or Sheets. A
 * product name or an operator-entered reason is untrusted text from that point
 * of view, so it is prefixed with an apostrophe to force it to stay text.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // CRLF: Excel is the overwhelmingly likely destination and handles it best.
  return `${lines.join("\r\n")}\r\n`;
}
