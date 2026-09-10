import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getInventoryRows, type InventoryLine } from "@/lib/admin-inventory";
import { getControlSnapshot } from "@/lib/admin-control";
import { tallyUnitsSoldByLineKey, type SoldOrderLine } from "@/lib/inventory-velocity";
import { buildWatchlist, type WatchlistEntry, type WatchlistSettings } from "@/lib/inventory-watchlist";

// ---------------------------------------------------------------------------
// The watch list, assembled from real data. All the decisions live in
// inventory-watchlist.ts (pure, fully tested); this file only fetches.
// ---------------------------------------------------------------------------

/**
 * How much sales history the pace is measured over. Thirty days is short enough
 * to react to a line that started moving and long enough that one big order
 * does not read as a permanent trend.
 */
export const SALES_WINDOW_DAYS = 30;

/** Owner-stated supplier turnaround. Overridable via the inventory settings. */
export const DEFAULT_LEAD_TIME_DAYS = 14;

/** Stock to hold beyond the lead time, so reordering is not a weekly chore. */
export const DEFAULT_COVER_TARGET_DAYS = 30;

/** PostgREST sends filters in the URL, so the id list is fetched in batches. */
const ORDER_ID_BATCH = 200;

/** Beyond this the pace is long since statistically settled. Bounds the read. */
const MAX_ORDERS_IN_WINDOW = 5000;

export interface InventoryWatchlist {
  entries: WatchlistEntry[];
  settings: WatchlistSettings;
  /** Every line considered, so the UI can say "3 of 48 need attention". */
  linesConsidered: number;
  /** Total units sold in the window — the honesty check on the forecast half. */
  unitsSoldInWindow: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value ?? Number.NaN);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Lead time and cover target, from the inventory settings section.
 *
 * Fails soft to the defaults: an unreadable setting must not stop the owner
 * seeing that they are about to run out of something.
 */
export async function getWatchlistSettings(): Promise<WatchlistSettings> {
  try {
    const snapshot = await getControlSnapshot("inventory");
    const cfg = (snapshot.inventory ?? {}) as Record<string, unknown>;
    return {
      leadTimeDays: positiveInteger(cfg.lead_time_days, DEFAULT_LEAD_TIME_DAYS),
      coverTargetDays: positiveInteger(cfg.cover_target_days, DEFAULT_COVER_TARGET_DAYS),
      salesWindowDays: SALES_WINDOW_DAYS,
    };
  } catch {
    return {
      leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
      coverTargetDays: DEFAULT_COVER_TARGET_DAYS,
      salesWindowDays: SALES_WINDOW_DAYS,
    };
  }
}

/**
 * Order lines for orders PAID inside the window.
 *
 * Two queries rather than a nested select: orders.order_id ↔
 * order_items.order_id is a text pair without a declared foreign key, so
 * PostgREST cannot embed one in the other.
 */
async function fetchPaidOrderLines(windowDays: number): Promise<SoldOrderLine[]> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .eq("payment_status", "paid")
    .gte("paid_at", cutoff)
    .limit(MAX_ORDERS_IN_WINDOW);

  if (orderError) throw orderError;

  const orderIds = (orders ?? [])
    .map((order) => String((order as { order_id?: unknown }).order_id ?? ""))
    .filter((id) => id.length > 0);

  if (orderIds.length === 0) return [];

  const lines: SoldOrderLine[] = [];
  for (let index = 0; index < orderIds.length; index += ORDER_ID_BATCH) {
    const batch = orderIds.slice(index, index + ORDER_ID_BATCH);
    const { data, error } = await supabaseAdmin
      .from("order_items")
      .select("product_id, quantity")
      .in("order_id", batch);

    if (error) throw error;
    for (const row of data ?? []) {
      lines.push({
        product_id: (row as { product_id?: string | null }).product_id ?? null,
        quantity: Number((row as { quantity?: unknown }).quantity ?? 0),
      });
    }
  }

  return lines;
}

/** slug -> products.id, for order lines written without a dose id. */
function productIdBySlug(lines: InventoryLine[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of lines) {
    if (line.productSlug && !map[line.productSlug]) {
      map[line.productSlug] = line.productId;
    }
  }
  return map;
}

export async function getInventoryWatchlist(): Promise<InventoryWatchlist> {
  // Deliberately the same getInventoryRows() the Inventory table renders, so
  // the watch list can never disagree with the rows underneath it about what is
  // in stock — including its dose-over-parent resolution and its exclusion of
  // archived products.
  const lines = await getInventoryRows();
  const settings = await getWatchlistSettings();
  const soldLines = await fetchPaidOrderLines(settings.salesWindowDays);
  const unitsSoldByKey = tallyUnitsSoldByLineKey(soldLines, productIdBySlug(lines));

  return {
    entries: buildWatchlist(lines, unitsSoldByKey, settings),
    settings,
    linesConsidered: lines.length,
    unitsSoldInWindow: Object.values(unitsSoldByKey).reduce((sum, units) => sum + units, 0),
  };
}

/**
 * Just the count that needs ordering now — out of stock, or emptying before a
 * resupply could land. Used by the dashboard tile, which has no room for rows.
 */
export async function getReorderCount(): Promise<number> {
  const { entries } = await getInventoryWatchlist();
  return entries.filter((entry) => entry.tier === "out" || entry.tier === "order-now").length;
}
