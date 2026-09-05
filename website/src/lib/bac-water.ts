import type { Product, ProductDose } from "@/lib/catalog-types";

// -------------------------------------------------------------------------
// BAC Water cross-sell helpers, shared by every surface that offers it:
// the product-page accessory block, "Frequently Bought Together", the
// add-to-cart nudge popup, and the cart checkboxes. Client-safe (no
// server-only imports) — prices always come from the live catalog row, so
// an admin price change propagates to every surface at once.
// -------------------------------------------------------------------------

/**
 * THE SLUGS THAT IDENTIFY BACTERIOSTATIC WATER, IN PREFERENCE ORDER.
 *
 * This list used to exist twice: once here as a single offered slug, and once
 * below as the exclusion set. The cross-sell LOOKUP asked for the single slug
 * while `isBacWater` recognised the set, so a store publishing its BAC water
 * under the other accepted slug served a 404 from /api/catalog/bac-water on
 * every page load — silently, since the cart checkboxes and the accessory block
 * simply do not render when the fetch fails. Reproduced in the browser: the
 * same product 404'd as "bac-water-30ml" and resolved as "bacteriostatic-water"
 * with no other change.
 *
 * One list now feeds both the recogniser and the resolver, so the two halves of
 * the cross-sell cannot disagree about what this product is called.
 */
// "bac-water" IS THE CANONICAL SLUG NOW, AND THE OLD ONES STAY RESOLVABLE.
//
// The product has always been called BAC Water on the page; only the URL still
// said "bacteriostatic-water", and a slug is not private — it was the canonical
// tag, the og:url, the breadcrumb, the sku in the Product schema and the
// sitemap entry. Every occurrence of the long word on the live site traced
// back to this one string.
//
// The older slugs are kept, not retired. They are what a shared link, a
// bookmark and Google's index still point at, and dropping them would 404 all
// three. Order matters: index 0 is what the app treats as canonical.
export const BAC_WATER_SLUG_CANDIDATES = ["bac-water", "bacteriostatic-water", "bac-water-30ml"] as const;

/** The SKU the cross-sell offers when more than one is published. */
export const BAC_WATER_SLUG = BAC_WATER_SLUG_CANDIDATES[0];

/**
 * IS THIS PRODUCT ITSELF BACTERIOSTATIC WATER?
 *
 * Used only to stop the cross-sell offering a product to itself. The catalogue
 * currently carries TWO published bacteriostatic water SKUs —
 * "bacteriostatic-water" (Solvents & Solutions) and "bac-water-30ml"
 * (Laboratory Supplies) — so matching the single offered slug left the other
 * one able to trigger a BAC Water offer for BAC Water.
 *
 * The name check is a deliberate safety net rather than a classification: this
 * is an EXCLUSION, so the cost of matching too much is one missed cross-sell,
 * while the cost of matching too little is a recursive offer. It also means a
 * third BAC Water SKU added later is excluded on the day it is created,
 * without anyone having to remember this file.
 *
 * Note this is the only place a name is inspected anywhere in the cross-sell.
 * Nothing here infers physical form, and nothing decides ELIGIBILITY from a
 * name, slug, category, strength or unit.
 */
const BAC_WATER_SLUGS = new Set<string>(BAC_WATER_SLUG_CANDIDATES);

export function isBacWater(product: { slug?: string; name?: string } | string | null | undefined) {
  const slug = (typeof product === "string" ? product : product?.slug ?? "").toLowerCase();
  const name = (typeof product === "string" ? "" : product?.name ?? "").toLowerCase();
  if (!slug && !name) return false;
  if (BAC_WATER_SLUGS.has(slug)) return true;
  return /bacteriostatic|bac[-\s]?water/.test(slug) || /bacteriostatic|bac[-\s]?water/.test(name);
}

function toPriceNumber(value?: string) {
  if (!value) return 0;
  return Number(value.replace(/[^0-9.]/g, "")) || 0;
}

export type BacWaterDoseOffer = {
  dose: ProductDose;
  /** Display label, e.g. "10 mL" */
  sizeLabel: string;
  /** Display price, e.g. "$14.99" */
  displayPrice: string;
  /** Numeric unit price for cart math. */
  unitPrice: number;
  /** The cart key this dose produces (slug::variantId). */
  cartKey: string;
};

/** The size to spotlight ("Most Popular") across every BAC Water surface. */
export const BAC_WATER_FEATURED_SUFFIX = "30ml";

export function isFeaturedBacWaterOffer(offer: BacWaterDoseOffer) {
  return (offer.dose.slugSuffix || offer.dose.label || "").toLowerCase().replace(/\s+/g, "") === BAC_WATER_FEATURED_SUFFIX;
}

export function getBacWaterDoseOffers(product: Product | null | undefined): BacWaterDoseOffer[] {
  if (!product?.doses?.length) return [];
  return product.doses
    .filter((dose) => dose.stockStatus !== "Out of Stock" && dose.stockStatus !== "Reserved")
    .map((dose) => {
      const displayPrice = dose.salePrice ?? dose.price;
      return {
        dose,
        sizeLabel: dose.label.replace(/(\d)(mL)/i, "$1 mL"),
        displayPrice,
        unitPrice: toPriceNumber(displayPrice),
        cartKey: `${product.slug}::${dose.id}`,
      };
    });
}

/** The options bag addToCart expects for a specific BAC Water dose. */
export function bacWaterAddOptions(product: Product, offer: BacWaterDoseOffer) {
  return {
    variantId: offer.dose.id,
    doseLabel: offer.dose.label,
    sku: offer.dose.sku,
    priceOverride: offer.unitPrice,
    imageOverride: offer.dose.imageUrl ?? product.image,
    batchNumberOverride: offer.dose.batchNumber ?? product.batchNumber,
    stockStatusOverride: offer.dose.stockStatus ?? product.stockStatus,
  };
}


/**
 * The published BAC water product, whichever accepted slug the store uses.
 *
 * Takes the lookup as an argument so this stays client-safe and directly
 * testable — the route passes `getCatalogProductBySlug`, which already filters
 * to active, enabled, published, non-archived rows and returns null otherwise.
 *
 * Candidates are tried in order and the first hit wins, so a store publishing
 * both SKUs keeps offering the preferred one. A throwing lookup is treated as a
 * miss rather than an error: a transient failure on the first slug must not
 * take out a cross-sell the second slug could still serve.
 */
export async function resolveBacWaterProduct(
  lookup: (slug: string) => Promise<Product | null>,
): Promise<Product | null> {
  for (const slug of BAC_WATER_SLUG_CANDIDATES) {
    try {
      const product = await lookup(slug);
      if (product) {
        return product;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
