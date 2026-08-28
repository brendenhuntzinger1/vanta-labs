import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isRevenueOrderStatus, isSaleOrder } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";

// Automatic best sellers: the products people actually buy the most. Ranks by
// total units sold across recent PAID orders (refunded/cancelled orders never
// counted, since they aren't paid). Result is a set of product slugs — the top
// sellers — used to badge + sort the storefront without any manual tagging.
//
// Cached in-memory for a few minutes so the storefront doesn't re-aggregate on
// every page view; best sellers shift slowly, so slight staleness is fine.

const CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKBACK_DAYS = 90;
const MAX_ORDERS_SCANNED = 3000;
/**
 * A ceiling on order LINES read per chunk of orders.
 *
 * order_items returns one row per LINE, not per order, so a chunk of 150 orders
 * is 150 x (however many products were in each cart). Sized well above any
 * plausible fan-out for that chunk size; reaching it would under-count units,
 * which is why it is not left implicit at PostgREST's 1000-row default.
 */
const MAX_ORDER_LINES_PER_CHUNK = 50_000;

let cache: { at: number; slugs: Set<string> } | null = null;

function slugFromProductId(productId: unknown): string {
  // Order lines store the cart id as "slug::variant"; the slug is the first part.
  return String(productId ?? "").split("::")[0];
}

interface OrderScanRow {
  order_id: string;
  payment_status: string | null;
  order_type?: string | null;
}

interface OrderLineRow {
  product_id: unknown;
  quantity: number | null;
}

async function computeBestSellerSlugs(limit: number): Promise<Set<string>> {
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // PAGED, NOT `.limit(MAX_ORDERS_SCANNED)`. PostgREST caps a single response at
  // 1000 rows by default and does it silently, so a `.limit(3000)` returned at
  // most a third of the lookback this module says it scans — and the shortfall
  // grows with the order table, never shrinks. The pager asks for the stated
  // 3000 and reports if it stopped short. order_id is a tiebreak: paging is only
  // deterministic when the sort is total, and two orders can share created_at.
  const { rows: orderRows } = await readAllRowsBounded<OrderScanRow>(
    (from, to) =>
      supabaseAdmin
        .from("orders")
        .select("order_id, payment_status, order_type, created_at")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: OrderScanRow[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_ORDERS_SCANNED, label: "best sellers orders" },
  );

  // "Units sold", so the same two questions the revenue surfaces ask (review
  // finding 4). A partially-refunded order really did sell its units — the
  // refund is often shipping, or one line of several — so excluding it
  // undercounts the product. A REPLACEMENT is the opposite: an outbound reship
  // the store paid for, which would rank a product that caused a problem as a
  // best seller off the back of its own failures.
  const paidOrderIds = orderRows
    .filter((o) => isRevenueOrderStatus(o.payment_status) && isSaleOrder(o.order_type))
    .map((o) => o.order_id)
    .filter(Boolean);
  if (paidOrderIds.length === 0) return new Set();

  // Fetch order lines in chunks so a large `.in(...)` never blows the URL limit.
  // CHUNK bounds the URL only — it is NOT a bound on rows returned. order_items
  // is one row per LINE, so 150 orders averaging more than ~6.7 lines each is
  // already past PostgREST's default 1000-row response cap, which truncates
  // without an error and drops the units on the floor. Hence the pager.
  const unitsBySlug = new Map<string, number>();
  const CHUNK = 150;
  for (let i = 0; i < paidOrderIds.length; i += CHUNK) {
    const chunk = paidOrderIds.slice(i, i + CHUNK);
    const { rows: itemRows } = await readAllRowsBounded<OrderLineRow>(
      (from, to) =>
        supabaseAdmin
          .from("order_items")
          .select("product_id, quantity")
          .in("order_id", chunk)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: OrderLineRow[] | null; error: { message?: string } | null }>,
      { maxRows: MAX_ORDER_LINES_PER_CHUNK, label: "best sellers order lines" },
    );
    for (const row of itemRows) {
      const slug = slugFromProductId(row.product_id);
      if (!slug) continue;
      unitsBySlug.set(slug, (unitsBySlug.get(slug) ?? 0) + Math.max(0, Number(row.quantity ?? 0)));
    }
  }

  return new Set(
    Array.from(unitsBySlug.entries())
      .filter(([, units]) => units > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([slug]) => slug),
  );
}

// Best sellers = the top 10 most-purchased products (by units sold across
// recent paid orders).
export async function getBestSellerSlugs(limit = 10): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.slugs;
  }
  try {
    const slugs = await computeBestSellerSlugs(limit);
    cache = { at: now, slugs };
    return slugs;
  } catch {
    // Never break the catalog over best-seller ranking — fall back to whatever
    // we had, or nothing.
    return cache?.slugs ?? new Set();
  }
}
