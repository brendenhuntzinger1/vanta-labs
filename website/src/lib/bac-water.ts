import type { Product, ProductDose } from "@/lib/catalog-types";

// -------------------------------------------------------------------------
// BAC Water cross-sell helpers, shared by every surface that offers it:
// the product-page accessory block, "Frequently Bought Together", the
// add-to-cart nudge popup, and the cart checkboxes. Client-safe (no
// server-only imports) — prices always come from the live catalog row, so
// an admin price change propagates to every surface at once.
// -------------------------------------------------------------------------

export const BAC_WATER_SLUG = "bacteriostatic-water";

export function isBacWater(slug: string) {
  return slug === BAC_WATER_SLUG;
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
