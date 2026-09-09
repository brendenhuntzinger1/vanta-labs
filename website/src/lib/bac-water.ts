import type { Product, ProductDose } from "@/lib/catalog-types";

// -------------------------------------------------------------------------
// Recon Water cross-sell helpers, shared by every surface that offers it:
// the product-page accessory block, "Frequently Bought Together", the
// add-to-cart nudge popup, and the cart checkboxes. Client-safe (no
// server-only imports) — prices always come from the live catalog row, so
// an admin price change propagates to every surface at once.
// -------------------------------------------------------------------------

/**
 * THE SLUGS THAT IDENTIFY RECON WATER, IN PREFERENCE ORDER.
 *
 * This list used to exist twice: once here as a single offered slug, and once
 * below as the exclusion set. The cross-sell LOOKUP asked for the single slug
 * while `isBacWater` recognised the set, so a store publishing its Recon water
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
// The product has always been called Recon Water on the page; only the URL still
// said "bacteriostatic-water", and a slug is not private — it was the canonical
// tag, the og:url, the breadcrumb, the sku in the Product schema and the
// sitemap entry. Every occurrence of the long word on the live site traced
// back to this one string.
//
// The older slugs are kept, not retired. They are what a shared link, a
// bookmark and Google's index still point at, and dropping them would 404 all
// three. Order matters: index 0 is what the app treats as canonical.
export const BAC_WATER_SLUG_CANDIDATES = ["recon-water", "bac-water", "bacteriostatic-water", "bac-water-30ml"] as const;

/** The SKU the cross-sell offers when more than one is published. */
export const BAC_WATER_SLUG = BAC_WATER_SLUG_CANDIDATES[0];

/**
 * THE SLUG A STORED CART LINE SHOULD BE CARRYING TODAY.
 *
 * A cart lives in localStorage and outlives a rename. `bacteriostatic-water`
 * stopped being a products row when production moved to `bac-water`, but every
 * browser that had added the vial before that day kept writing the old slug —
 * to storage, and from there to the tracking beacon and into abandoned_carts.
 * Two live carts were repaired by hand and BOTH reverted within a day, because
 * repairing a row does nothing about the client that keeps re-posting it.
 *
 * quoteOrder throws `Invalid product id` on a slug with no product row and
 * fails the WHOLE quote, so such a cart cannot check out at all. This is the
 * source fix: the cart is migrated as it is read, so the stale slug stops being
 * written. The restore endpoint reconciles as well, and keeps doing so — that
 * is defence in depth for carts stored before this shipped, and for any future
 * rename nobody remembers to handle here.
 *
 * Client-safe by construction: a pure lookup over a list, no catalogue read.
 * It is deliberately NOT a general "guess the product" — only slugs in a known
 * alias family are rewritten, and everything else is returned untouched.
 */
export function canonicalCartSlug(slug: string): string {
  const candidate = String(slug ?? "").trim();
  if (!candidate) return candidate;
  return (BAC_WATER_SLUG_CANDIDATES as readonly string[]).includes(candidate)
    ? BAC_WATER_SLUG
    : candidate;
}

/**
 * IS THIS PRODUCT ITSELF RECON WATER?
 *
 * Used only to stop the cross-sell offering a product to itself. The catalogue
 * currently carries TWO published recon water SKUs —
 * "bacteriostatic-water" (Solvents & Solutions) and "bac-water-30ml"
 * (Laboratory Supplies) — so matching the single offered slug left the other
 * one able to trigger a Recon Water offer for Recon Water.
 *
 * The name check is a deliberate safety net rather than a classification: this
 * is an EXCLUSION, so the cost of matching too much is one missed cross-sell,
 * while the cost of matching too little is a recursive offer. It also means a
 * third Recon Water SKU added later is excluded on the day it is created,
 * without anyone having to remember this file.
 *
 * Note this is the only place a name is inspected anywhere in the cross-sell.
 * Nothing here infers physical form, and nothing decides ELIGIBILITY from a
 * name, slug, category, strength or unit.
 */
const BAC_WATER_SLUGS = new Set<string>(BAC_WATER_SLUG_CANDIDATES);

// Matches the product under every name it has traded under. "recon" is listed
// because the catalogue row is named "Recon water" now, and this guard reads
// the NAME as well as the slug -- dropping the old words would un-match every
// stored cart line and order that still carries them.
const RECON_WATER_PATTERN = /bacteriostatic|bac[-\s]?water|recon[-\s]?water/;

export function isBacWater(product: { slug?: string; name?: string } | string | null | undefined) {
  const slug = (typeof product === "string" ? product : product?.slug ?? "").toLowerCase();
  const name = (typeof product === "string" ? "" : product?.name ?? "").toLowerCase();
  if (!slug && !name) return false;
  if (BAC_WATER_SLUGS.has(slug)) return true;
  return RECON_WATER_PATTERN.test(slug) || RECON_WATER_PATTERN.test(name);
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

/** The size to spotlight ("Most Popular") across every Recon Water surface. */
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

/** The options bag addToCart expects for a specific Recon Water dose. */
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
 * The published Recon water product, whichever accepted slug the store uses.
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

/**
 * WHAT THE CART'S RECON WATER CHECKBOX SAYS ABOUT ITS OWN STATE.
 *
 * The control is a toggle: ticked means "this size is in your cart", and
 * unticking removes it. It rendered one set of words for both states — "Add
 * 10 mL Recon Water   +$14.99" — so a shopper who already had the bottle saw a
 * ticked box under the heading "Complete your order", offering to add the thing
 * sitting in the line above it, at a price prefixed with a plus. Reported from
 * a phone as looking like a double charge, which is exactly what it looks like.
 *
 * Ticked, the money is already in the subtotal, so the plus goes and the label
 * states the fact instead of repeating the offer. The action a tick performs is
 * unchanged; only its description of itself is.
 */
export function bacWaterCheckboxCopy(input: {
  sizeLabel: string;
  displayPrice: string;
  inCart: boolean;
}): { label: string; price: string; ariaLabel: string } {
  if (input.inCart) {
    return {
      label: `${input.sizeLabel} Recon Water — in your cart`,
      price: input.displayPrice,
      ariaLabel: `Remove ${input.sizeLabel} Recon Water from your order`,
    };
  }
  return {
    label: `Add ${input.sizeLabel} Recon Water`,
    price: `+${input.displayPrice}`,
    ariaLabel: `Add ${input.sizeLabel} Recon Water to your order`,
  };
}
