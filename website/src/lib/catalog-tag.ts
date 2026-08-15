/**
 * The cache tag shared by every cached catalog read.
 *
 * Kept in its own module (rather than in catalog.ts) so that a write path can
 * invalidate the catalog without importing catalog.ts, which pulls in the
 * Supabase admin client and the whole read layer with it.
 */
export const CATALOG_CACHE_TAG = "catalog";
