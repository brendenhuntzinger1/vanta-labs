/**
 * One place that decides what image a product shows when it has no photo.
 *
 * This exists because the previous fallback — `/images/vantalabs.png` — was a
 * screenshot of a product page. It carried a supplier code, a price, a bundle
 * offer and a purity figure printed on the vial label, and it was wired into
 * the OpenGraph tag, the Twitter card, the Organization logo and every missing
 * product thumbnail at once. Any product without its own photo advertised all
 * of that.
 *
 * The legacy path is still recognised here rather than simply deleted, because
 * product rows in the database may store it as their literal `image_url`. Those
 * rows resolve to the neutral placeholder instead of 404ing.
 */

export const PRODUCT_IMAGE_FALLBACK = "/images/product-placeholder.png";

/**
 * Paths that are placeholders rather than photography. A caller that wants to
 * render its own empty state (the COA library does) checks against this instead
 * of showing a picture of nothing.
 */
export const PLACEHOLDER_IMAGE_PATHS: readonly string[] = [
  PRODUCT_IMAGE_FALLBACK,
  "/images/vantalabs.png",
];

function normalise(url: string | null | undefined): string {
  return String(url ?? "").trim();
}

export function isPlaceholderProductImage(url: string | null | undefined): boolean {
  const value = normalise(url);
  if (!value) return true;
  return PLACEHOLDER_IMAGE_PATHS.some((path) => value === path || value.endsWith(path));
}

/**
 * Resolve a stored image URL to something safe to render. Empty, missing, or
 * legacy-screenshot values all collapse to the neutral brand tile.
 */
export function resolveProductImage(url: string | null | undefined): string {
  const value = normalise(url);
  if (!value || isPlaceholderProductImage(value)) return PRODUCT_IMAGE_FALLBACK;
  return value;
}
