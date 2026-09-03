import type { Product } from "@/lib/catalog-types";

/**
 * The catalogue's resting order: best sellers first, everything else left in
 * catalogue order.
 *
 * IN ITS OWN MODULE BECAUSE BOTH SIDES NEED IT. The `/products` page paints the
 * first view of this grid on the server and the client component re-renders the
 * same products a frame later; if the two disagree about order, that frame is a
 * visible shuffle under the reader. So it is one function, not two copies —
 * and it lives apart from `storefront-catalog.ts`, which reaches the database
 * and must never be pulled into the browser bundle.
 *
 * Mirrors the "default" case of the sort in products-client.tsx. `sort` is
 * stable in every engine we support, so ties hold their catalogue position.
 */
export function inDefaultCatalogOrder(products: Product[]): Product[] {
  return [...products].sort(
    (a, b) => (a.isBestSeller ? 0 : 1) - (b.isBestSeller ? 0 : 1),
  );
}
