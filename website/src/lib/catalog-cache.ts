import "server-only";

import { revalidateTag } from "next/cache";
import { CATALOG_CACHE_TAG } from "@/lib/catalog-tag";

/**
 * Drop the cached catalog reads so the very next storefront request re-queries
 * the database.
 *
 * WHY THIS EXISTS. The catalog reads in catalog.ts are wrapped in
 * `unstable_cache` with a 60s TTL and the shared `catalog` tag. The tag was
 * always there; nothing ever called `revalidateTag` on it. The only thing that
 * ever cleared the cache was the TTL expiring — and because time-based
 * revalidation is stale-while-revalidate, the FIRST request after expiry still
 * served the old numbers and merely kicked off the refresh in the background.
 * The practical effect for the owner was: save a count in /admin/inventory,
 * reload the product page, still see the old availability, reload again, maybe
 * see the new one. That is this function's entire reason for existing.
 *
 * Call it after ANY write that can change what the storefront should display:
 * a manual inventory save, a stock operation, a product/dose edit, and the
 * automatic movements that happen when an order is paid, canceled or refunded.
 *
 * Best-effort by contract. The stock has already moved by the time this runs,
 * so a failure here must never fail the operation that succeeded — the worst
 * case is that the old 60s TTL behaviour applies for one more minute.
 *
 * Caveat worth knowing: `revalidateTag` is local to the serving instance
 * unless the deployment's cache handler shares tag state (Vercel's Data Cache
 * does; a plain multi-instance self-host does not). Where it is not shared, the
 * TTL remains the backstop.
 */
export function invalidateCatalogCache(): void {
  try {
    // `{ expire: 0 }`, NOT the recommended `"max"` profile. "max" is
    // stale-while-revalidate: it marks the entry stale and still serves the old
    // numbers to the next visitor while refreshing behind them. That is the
    // exact symptom being fixed — the owner saves 5 units, reloads, and sees the
    // previous count. Expiring immediately makes the next request a blocking
    // miss that re-queries the database, which is what "read your own writes"
    // requires. (`updateTag`, the purpose-built API for this, is restricted to
    // Server Actions; every one of these call sites is a Route Handler.)
    revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.error("[catalog-cache] revalidateTag failed", error);
  }
}
