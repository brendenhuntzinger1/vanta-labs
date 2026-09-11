// No `server-only` here: the pure parts of the browse follow-up. The click
// route, the sweep and the tests all import from this file.

/**
 * BROWSE ABANDONMENT — THE RULES THAT DO NOT NEED A DATABASE.
 *
 * A viewed product, an identifiable and consented customer, no cart and no
 * purchase, one useful note after a few hours, no incentive. Design:
 * docs/superpowers/specs/2026-09-11-recovery-to-benchmark-design.md §6.
 *
 * THE WINDOW IS FIXED IN CODE, NOT IN THE AUTOMATION'S DELAY FIELD. Every
 * other automation is timed in days from an event; this one is timed in hours
 * from a page view, and a view older than a day is not worth a message — the
 * shopper has moved on, or bought, or is in the cart flow's hands. The
 * automation row's delay_days is stored as 0 to say so.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A view younger than this is still a live session, not an abandonment. */
export const BROWSE_MIN_AGE_MS = 4 * HOUR_MS;
/** A view older than this never triggers; the same shape as EVENT_GRACE_DAYS. */
export const BROWSE_MAX_AGE_MS = 24 * HOUR_MS;
/** One browse note per address per week, whatever they looked at. */
export const BROWSE_REPEAT_MS = 7 * DAY_MS;

/**
 * The cart statuses that mean "the cart flow owns this address". Kept here as
 * a literal rather than imported from cart-recovery.ts so the automation sweep
 * does not pull the whole recovery module into its import graph; the test
 * beside this file pins it equal to CART_STATUS_OPEN.
 */
export const BROWSE_OPEN_CART_STATUSES = ["active", "held"] as const;

/** Catalogue slugs are lower-case words joined by hyphens; nothing else lands on a product page. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isBrowseSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * THE SEND-ONCE REFERENCE: address, product and the view's UTC day.
 *
 * The address makes it the customer's; the slug makes a later look at a
 * different product a different episode; the day stops a second view of the
 * same product the same day producing a second message. The seven-day rule is
 * applied separately, per address, by the sweep's lookback.
 *
 * The slug is INSIDE the reference, and the reference is inside the click
 * link's HMAC, so the click route can land the customer on the product they
 * looked at without taking a destination from the URL.
 */
export function browseReferenceId(email: string, slug: string, viewedAt: number): string {
  const day = new Date(viewedAt).toISOString().slice(0, 10);
  return `${email.trim().toLowerCase()}:${slug}:${day}`;
}

/**
 * Parsed from the END, because the address may in principle hold a colon and
 * the slug and day never do.
 */
export function parseBrowseReference(reference: string): { email: string; slug: string; day: string } | null {
  const parts = String(reference ?? "").split(":");
  if (parts.length < 3) return null;
  const day = parts[parts.length - 1] ?? "";
  const slug = parts[parts.length - 2] ?? "";
  const email = parts.slice(0, -2).join(":");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isBrowseSlug(slug) || !email) return null;
  return { email, slug, day };
}

/**
 * Where a browse click lands: the product page of the viewed product, or null
 * when the reference does not carry a usable slug (the route then falls back
 * to the automation row's stored path, like every other automation).
 */
export function browseDestinationPath(reference: string): string | null {
  const parsed = parseBrowseReference(reference);
  return parsed ? `/products/${parsed.slug}` : null;
}

/** `{{product_name}}` in operator copy becomes the catalogue name; nothing else is substituted. */
export function mergeProductName(copy: string, productName: string): string {
  return String(copy ?? "").replace(/\{\{\s*product_name\s*\}\}/gi, productName);
}
