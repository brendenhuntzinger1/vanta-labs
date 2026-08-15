/**
 * Reddit conversion events.
 *
 * Pure builders, no DOM and no network, for the same reason snap-events.ts is:
 * the payload shape is the part worth testing, and a builder that cannot send
 * anything cannot be the thing that accidentally sends something.
 *
 * ONLY REDDIT'S STANDARD EVENTS. Its documented set is PageVisit, ViewContent,
 * Search, AddToCart, AddToWishlist, Purchase, Lead and SignUp. There is no
 * InitiateCheckout — TikTok and Snap both have one and it is the obvious thing
 * to reach for, but Reddit would record it as a custom event that no campaign
 * objective can optimise against, so begin-checkout is deliberately not
 * forwarded here.
 *
 * NO IDENTITY ON EVENTS. Reddit's event schema accepts `email` and
 * `phoneNumber`. Identity is attached exactly once, at init, as a server-side
 * SHA-256 digest — see reddit-matching.ts. Putting it on events as well would
 * mean a raw address in browser code on the one page where the site knows who
 * the visitor is, which is precisely what the TikTok and Snap integrations are
 * built to avoid.
 */

export type RedditEventName = "ViewContent" | "AddToCart" | "Purchase";

export type RedditProduct = {
  id: string;
  name?: string;
  category?: string;
};

export type RedditEvent = {
  name: RedditEventName;
  properties: {
    currency: "USD";
    value?: number;
    itemCount?: number;
    products?: RedditProduct[];
    /**
     * The deduplication key. Reddit collapses a pixel event and a Conversions
     * API event carrying the same conversionId into one conversion, which is
     * what its "Prepare for deduplication" setup step is asking for. Sending it
     * from the start means the server leg can be added later without
     * double-counting anything already live.
     */
    conversionId?: string;
  };
};

/**
 * Money as Reddit expects it: a number of dollars, two decimals, never a string.
 *
 * ABSENT IS NOT ZERO. `Number(null)` is 0 and `Number(undefined)` is NaN, so a
 * naive coercion turns "we don't know the price" into a genuine $0.00 — and a
 * zero-value event is a real number to Reddit's optimiser, not a blank. Missing
 * inputs must produce undefined so the caller can omit the field entirely.
 */
function money(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100) / 100;
}

function positiveInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * A product line. `id` carries the variant when there is one, matching the cart
 * line id the rest of the system uses (`slug::doseId`), so a Reddit report can
 * be reconciled against an order without guessing which dose was bought.
 */
function product(input: {
  slug: string;
  variantId?: string | null;
  name?: string | null;
  category?: string | null;
}): RedditProduct | null {
  const slug = String(input.slug ?? "").trim();
  if (!slug) return null;
  const item: RedditProduct = { id: input.variantId ? `${slug}::${input.variantId}` : slug };
  if (input.name) item.name = String(input.name);
  if (input.category) item.category = String(input.category);
  return item;
}

export function buildRedditViewContent(input: {
  slug: string;
  variantId?: string | null;
  name?: string | null;
  category?: string | null;
  price?: number | null;
}): RedditEvent | null {
  const item = product(input);
  if (!item) return null;
  const value = money(input.price);
  return {
    name: "ViewContent",
    properties: { currency: "USD", products: [item], ...(value !== undefined ? { value } : {}) },
  };
}

export function buildRedditAddToCart(input: {
  slug: string;
  variantId?: string | null;
  name?: string | null;
  category?: string | null;
  quantity?: number | null;
  price?: number | null;
}): RedditEvent | null {
  const item = product(input);
  if (!item) return null;
  const quantity = positiveInt(input.quantity) ?? 1;
  const unit = money(input.price);
  return {
    name: "AddToCart",
    properties: {
      currency: "USD",
      itemCount: quantity,
      products: [item],
      // Line value, not unit price — Reddit reports `value` as the money the
      // action represents, and two vials is twice the intent of one.
      ...(unit !== undefined ? { value: money(unit * quantity) } : {}),
    },
  };
}

export function buildRedditPurchase(input: {
  orderId: string;
  total?: number | null;
  itemCount?: number | null;
  items?: Array<{ slug: string; variantId?: string | null; name?: string | null; category?: string | null }>;
}): RedditEvent | null {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return null;
  const value = money(input.total);
  const products = (input.items ?? []).map(product).filter((item): item is RedditProduct => item !== null);
  return {
    name: "Purchase",
    properties: {
      currency: "USD",
      // The order id, so a later Conversions API call for the same order
      // collapses into one conversion rather than doubling the reported revenue.
      conversionId: orderId,
      ...(value !== undefined ? { value } : {}),
      ...(positiveInt(input.itemCount) !== undefined ? { itemCount: positiveInt(input.itemCount) } : {}),
      ...(products.length > 0 ? { products } : {}),
    },
  };
}

/**
 * Hand an event to the pixel.
 *
 * Takes the emitter rather than reaching for `window.rdt` so the builders stay
 * testable and the caller keeps the consent check in one place: the pixel only
 * exists after consent, so its absence IS the check.
 */
export function emitRedditEvent(
  event: RedditEvent | null,
  emit: (name: string, properties: Record<string, unknown>) => void,
): boolean {
  if (!event) return false;
  emit(event.name, event.properties);
  return true;
}
