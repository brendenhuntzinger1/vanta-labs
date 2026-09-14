/**
 * Meta Pixel ecommerce events — the pure half.
 *
 * A deliberate mirror of snap-events.ts and tiktok-events.ts: same funnel,
 * same authoritative numbers, same derived-not-random identifiers. The rules
 * that carry over are the ones that matter:
 *
 * **Never invent a number.** Every price traces to a catalogue or settled
 * figure; an unknown price is omitted, never zeroed.
 *
 * **Purchase is gated on the backend's paid state, never on a URL.**
 *
 * **One action, one event.** `eventID` is derived from the thing it describes
 * and is the SAME key TikTok's `event_id` uses for the same action, so a
 * reconciliation can line the platforms up — and so a future Conversions API
 * leg reporting the same purchase under the same id collapses into one
 * conversion rather than two. Meta's docs call this deduplication; it only
 * works if the browser sends the id from day one.
 *
 * The product identifier is the SAME catalogue slug every other platform
 * receives. Meta's parameter reference: `content_ids` + `content_type:
 * "product"` is what Advantage+ catalog ads match against, `contents` carries
 * per-line quantity and price, `value`/`currency` is what ROAS is computed
 * from, and `num_items` is Meta's count for InitiateCheckout/Purchase.
 *
 * NO IDENTITY ON EVENTS. Meta's browser pixel accepts Advanced Matching only
 * as a second argument to `fbq('init')`, hashed or raw. Nothing here builds
 * that: identity for this store is a server-side SHA-256 digest attached on a
 * paid order (see advanced-matching.ts), and the root layout — where init
 * runs — does not know who the visitor is. The event builders therefore have
 * no identity fields at all, which is what makes handing Meta a raw address
 * impossible by accident rather than merely discouraged.
 */

import { money, resolveContentId, type PaidOrder } from "./tiktok-events";

/** Meta's standard event names. PascalCase, exactly as Events Manager lists them. */
export type MetaEventName = "PageView" | "ViewContent" | "AddToCart" | "InitiateCheckout" | "Purchase";

export type MetaContent = { id: string; quantity: number; item_price?: number };

export type MetaEvent = {
  name: MetaEventName;
  properties: {
    content_ids?: string[];
    content_type?: "product";
    content_name?: string;
    content_category?: string;
    contents?: MetaContent[];
    value?: number;
    currency?: string;
    num_items?: number;
  };
  /** Meta's deduplication key. Derived, never random. */
  eventId: string;
  /** Storage key that makes this event fire at most once where that matters. */
  dedupeKey: string | null;
};

export const META_CURRENCY = "USD";

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function wholeQuantity(value: unknown): number {
  return Math.max(1, Math.floor(Number(value) || 1));
}

/**
 * Meta takes one category per event, not one per line. With a single distinct
 * category that is unambiguous; with several, any choice misdescribes the
 * rest, so the field is omitted rather than guessed at.
 */
function singleCategory(values: (string | null | undefined)[]): string | undefined {
  const distinct = new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

export function buildMetaViewContent(input: {
  slug: string;
  name?: string | null;
  price?: number;
  category?: string | null;
}): MetaEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const price = isPositive(input.price) ? money(input.price) : undefined;
  const category = singleCategory([input.category]);
  return {
    name: "ViewContent",
    properties: {
      content_ids: [id],
      content_type: "product",
      ...(input.name ? { content_name: input.name } : {}),
      ...(category ? { content_category: category } : {}),
      contents: [{ id, quantity: 1, ...(price !== undefined ? { item_price: price } : {}) }],
      // Omitted rather than zeroed when unknown: a zero-value view teaches the
      // optimiser that the product is worthless.
      ...(price !== undefined ? { value: price, currency: META_CURRENCY } : {}),
    },
    eventId: `vc-${id}`,
    dedupeKey: null,
  };
}

export function buildMetaAddToCart(input: {
  slug: string;
  variantId?: string | null;
  name?: string | null;
  category?: string | null;
  quantity: number;
  price: number;
}): MetaEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const quantity = wholeQuantity(input.quantity);
  const unit = isPositive(input.price) ? money(input.price) : 0;
  const category = singleCategory([input.category]);
  // Matches TikTok's event id exactly, so the two platforms describe the same
  // action with the same key.
  const variantKey = input.variantId ? `${id}::${input.variantId}` : id;
  return {
    name: "AddToCart",
    properties: {
      content_ids: [id],
      content_type: "product",
      ...(input.name ? { content_name: input.name } : {}),
      ...(category ? { content_category: category } : {}),
      contents: [{ id, quantity, item_price: unit }],
      value: money(unit * quantity),
      currency: META_CURRENCY,
    },
    eventId: `atc-${variantKey}`,
    dedupeKey: null,
  };
}

export function buildMetaInitiateCheckout(input: {
  itemCount: number;
  total: number;
  items?: { slug?: string | null; quantity?: number | null; price?: number | null; category?: string | null }[];
}): MetaEvent | null {
  const total = money(input.total);
  if (!isPositive(total)) return null;
  const contents: MetaContent[] = [];
  for (const item of input.items ?? []) {
    const id = resolveContentId({ slug: item.slug });
    if (!id) continue;
    contents.push({
      id,
      quantity: wholeQuantity(item.quantity),
      ...(isPositive(item.price) ? { item_price: money(item.price) } : {}),
    });
  }
  const category = singleCategory((input.items ?? []).map((item) => item.category));
  return {
    name: "InitiateCheckout",
    properties: {
      ...(contents.length > 0
        ? { content_ids: contents.map((entry) => entry.id), content_type: "product" as const, contents }
        : {}),
      ...(category ? { content_category: category } : {}),
      value: total,
      currency: META_CURRENCY,
      num_items: wholeQuantity(input.itemCount),
    },
    eventId: `ic-${input.itemCount}-${total}`,
    dedupeKey: null,
  };
}

/**
 * The one event that represents money.
 *
 * Returns null unless the order is paid AND a positive amount settled — the
 * same two conditions every other platform's builder applies, read from the
 * same order.
 */
export function buildMetaPurchase(order: PaidOrder, options?: { categories?: (string | null | undefined)[] }): MetaEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const value = money(order.amountPaid);
  if (!isPositive(value)) return null;

  const contents: MetaContent[] = [];
  for (const item of order.items) {
    const id = resolveContentId({ slug: item.slug, productId: item.productId });
    if (!id) continue;
    contents.push({
      id,
      quantity: wholeQuantity(item.quantity),
      ...(isPositive(item.unitPrice) ? { item_price: money(item.unitPrice) } : {}),
    });
  }
  const category = singleCategory(options?.categories ?? []);

  return {
    name: "Purchase",
    properties: {
      // Falls back to naming the order, exactly as the other builders do, so a
      // purchase is never reported without identifying anything.
      content_ids: contents.length > 0 ? contents.map((entry) => entry.id) : [`order-${order.orderId}`],
      content_type: "product",
      ...(contents.length > 0 ? { contents } : {}),
      ...(category ? { content_category: category } : {}),
      value,
      currency: META_CURRENCY,
      num_items: order.items.reduce((sum, item) => sum + wholeQuantity(item.quantity), 0) || 1,
    },
    eventId: `purchase-${order.orderId}`,
    dedupeKey: `meta-purchase:${order.orderId}`,
  };
}

export type MetaEmitter = (name: MetaEventName, properties: Record<string, unknown>, options: { eventID: string }) => void;

/** Send an event, honouring its dedupe key. Mirrors emitEvent for TikTok. */
export function emitMetaEvent(
  event: MetaEvent | null,
  emit: MetaEmitter,
  store: { has(key: string): boolean; mark(key: string): void },
): boolean {
  if (!event) return false;
  if (event.dedupeKey && store.has(event.dedupeKey)) return false;
  emit(event.name, event.properties, { eventID: event.eventId });
  if (event.dedupeKey) store.mark(event.dedupeKey);
  return true;
}
