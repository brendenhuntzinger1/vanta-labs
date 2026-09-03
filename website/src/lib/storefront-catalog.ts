// Reaches the database. Importing this from a client component would pull the
// Supabase server client into the browser bundle, which is a build error rather
// than a silent leak — and it was, once.
import "server-only";
import { getCatalogProducts } from "@/lib/catalog";
import { getBestSellerSlugs } from "@/lib/best-sellers";
import type { Product } from "@/lib/catalog-types";

/**
 * The catalogue as the storefront shows it: every published product, with the
 * best-seller flag resolved from real sales.
 *
 * ONE SOURCE, TWO CALLERS, ON PURPOSE. `/api/catalog/products` and the
 * `/products` page both need exactly this list, and they now render it at the
 * same moment — the page paints it on the server and the client takes it over
 * on hydration. Computing "is this a best seller" separately in each would let
 * the two answers drift, and a drift shows up as the catalogue visibly
 * re-ordering itself under the reader a beat after it appears, because the
 * default sort is best-sellers-first.
 *
 * A sales lookup failure degrades to "no best sellers" rather than taking the
 * catalogue down with it; a manual badge still counts, so an admin can always
 * feature something by hand.
 */
export async function getStorefrontCatalog(): Promise<Product[]> {
  const [products, bestSellerSlugs] = await Promise.all([
    getCatalogProducts(),
    getBestSellerSlugs().catch(() => new Set<string>()),
  ]);

  return products.map((product) => ({
    ...product,
    isBestSeller: bestSellerSlugs.has(product.slug) || product.badge === "best_seller",
  }));
}
