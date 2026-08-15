/**
 * The most units of a single line one order may contain.
 *
 * It is the ceiling the product page's quantity controls already enforced, and
 * it doubles as a PRIVACY CLAMP on published availability: the storefront needs
 * to know whether it can offer 1, 3, 5 or 10 of something, and it needs to know
 * when there are none — it never needs to know that the shelf holds 247. So the
 * availability figure serialized into the page is clamped to this number, and a
 * customer reading the page source learns at most "ten or more", never the real
 * count.
 *
 * Shared by the catalog read layer and the product page so the clamp and the
 * control that depends on it can never drift apart.
 */
export const MAX_UNITS_PER_ORDER_LINE = 10;
