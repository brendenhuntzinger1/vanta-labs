import type { Product } from "@/lib/catalog-types";

export type CatalogSortKey = "default" | "price-asc" | "price-desc" | "name-asc" | "purity";

/**
 * Can a shopper actually buy this right now?
 *
 * "Reserved" counts as sold out alongside "Out of Stock" because the card
 * treats it that way: neither can be added to the cart, and both show the same
 * Out of Stock badge. A missing status is NOT sold out — an untracked catalogue
 * resolves everything to In Stock (see resolveStockStatus in lib/catalog.ts),
 * so absence means "not counted", never "none left".
 */
export function isSoldOut(product: Product): boolean {
  return product.stockStatus === "Out of Stock" || product.stockStatus === "Reserved";
}

function parsePrice(price: string) {
  return Number(price.replace(/[^0-9.]/g, "")) || 0;
}

function parsePurity(purity?: string) {
  return Number((purity ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

/**
 * The shopper's chosen ordering, applied WITHIN each availability group.
 *
 * `default` lifts best sellers and leaves everything else in catalogue
 * position — `sort` is stable in every engine we support, so returning 0 holds
 * the incoming order.
 */
const COMPARATORS: Record<CatalogSortKey, (a: Product, b: Product) => number> = {
  default: (a, b) => (a.isBestSeller ? 0 : 1) - (b.isBestSeller ? 0 : 1),
  "price-asc": (a, b) => parsePrice(a.price) - parsePrice(b.price),
  "price-desc": (a, b) => parsePrice(b.price) - parsePrice(a.price),
  "name-asc": (a, b) => a.name.localeCompare(b.name),
  purity: (a, b) => parsePurity(b.purityResult) - parsePurity(a.purityResult),
};

/**
 * Orders the catalogue: SOLD OUT LAST, ALWAYS, then the requested sort.
 *
 * IN ITS OWN MODULE BECAUSE BOTH SIDES NEED IT. The `/products` page paints the
 * first view of this grid on the server and the client component re-renders the
 * same products a frame later; if the two disagree about order, that frame is a
 * visible shuffle under the reader. So it is one function, not two copies —
 * and it lives apart from `storefront-catalog.ts`, which reaches the database
 * and must never be pulled into the browser bundle.
 *
 * THE AVAILABILITY RULE OUTRANKS THE SORT, and that is the point of it. A sold
 * out card is a dead end — it cannot be added to the cart, and the shopper's
 * only move from there is a restock alert. Sorting by price used to open the
 * grid with whatever happened to be cheapest, sold out or not; on a phone, two
 * columns, that is most of the first screen spent on things nobody can buy.
 * Sinking them costs the sold-out product nothing (it is still listed, still
 * linked, still crawlable) and gives every row above it something purchasable.
 *
 * The chosen sort still applies inside the sold-out block, so "price: low to
 * high" is honestly answered there too — it is a demotion, not a discard.
 */
export function sortCatalogBy(products: Product[], sort: CatalogSortKey): Product[] {
  const compare = COMPARATORS[sort] ?? COMPARATORS.default;
  return [...products].sort((a, b) => {
    const availability = Number(isSoldOut(a)) - Number(isSoldOut(b));
    return availability !== 0 ? availability : compare(a, b);
  });
}

/**
 * The catalogue's resting order: sold out last, best sellers first among the
 * rest, everything else left in catalogue order. Mirrors the "default" case of
 * the sort in products-client.tsx because it IS that case.
 */
export function inDefaultCatalogOrder(products: Product[]): Product[] {
  return sortCatalogBy(products, "default");
}
