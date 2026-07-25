import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isPaidOrderStatus } from "@/lib/ledger";

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

let cache: { at: number; slugs: Set<string> } | null = null;

function slugFromProductId(productId: unknown): string {
  // Order lines store the cart id as "slug::variant"; the slug is the first part.
  return String(productId ?? "").split("::")[0];
}

async function computeBestSellerSlugs(limit: number): Promise<Set<string>> {
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: orderRows, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id, payment_status, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(MAX_ORDERS_SCANNED);
  if (orderError) throw orderError;

  const paidOrderIds = ((orderRows ?? []) as Array<{ order_id: string; payment_status: string | null }>)
    .filter((o) => isPaidOrderStatus(o.payment_status))
    .map((o) => o.order_id)
    .filter(Boolean);
  if (paidOrderIds.length === 0) return new Set();

  // Fetch order lines in chunks so a large `.in(...)` never blows the URL limit.
  const unitsBySlug = new Map<string, number>();
  const CHUNK = 150;
  for (let i = 0; i < paidOrderIds.length; i += CHUNK) {
    const chunk = paidOrderIds.slice(i, i + CHUNK);
    const { data: itemRows, error: itemError } = await supabaseAdmin
      .from("order_items")
      .select("product_id, quantity")
      .in("order_id", chunk);
    if (itemError) throw itemError;
    for (const row of (itemRows ?? []) as Array<{ product_id: unknown; quantity: number | null }>) {
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

export async function getBestSellerSlugs(limit = 6): Promise<Set<string>> {
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
