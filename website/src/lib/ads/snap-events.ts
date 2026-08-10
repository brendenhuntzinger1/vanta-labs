/**
 * Snapchat ecommerce events — the pure half.
 *
 * A deliberate mirror of tiktok-events.ts: same funnel, same authoritative
 * numbers, same derived-not-random identifiers. Two ad platforms disagreeing
 * about the same order is a reporting problem nobody notices until they are
 * reconciling spend, so both are built from the same inputs and the same rules.
 *
 * Three things carry over unchanged because they are the rules that matter:
 *
 * **Never invent a number.** Every price traces to a catalogue or settled
 * figure.
 *
 * **Purchase is gated on the backend's paid state, never on a URL.**
 *
 * **One action, one event.** `client_dedup_id` is derived from the thing it
 * describes, which is what lets Snap collapse a browser event and a future
 * Conversions API event into one conversion instead of two.
 *
 * The product identifier is the SAME catalogue slug TikTok receives. Reporting
 * a product as `bpc-157` on one platform and something else on the other makes
 * cross-channel comparison impossible for no benefit.
 */

import { money, resolveContentId, type PaidOrder } from "./tiktok-events";

/** Snap's standard event names. Uppercase, unlike TikTok's PascalCase. */
export type SnapEventName = "PAGE_VIEW" | "VIEW_CONTENT" | "ADD_CART" | "START_CHECKOUT" | "PURCHASE";

export type SnapEvent = {
  name: SnapEventName;
  properties: {
    item_ids?: string[];
    item_category?: string;
    price?: number;
    currency?: string;
    number_items?: number;
    transaction_id?: string;
    /** Snap's deduplication key. Derived, never random. */
    client_dedup_id: string;
  };
  /** Storage key that makes this event fire at most once where that matters. */
  dedupeKey: string | null;
};

export const SNAP_CURRENCY = "USD";

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function buildSnapViewContent(input: { slug: string; price?: number }): SnapEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const price = isPositive(input.price) ? money(input.price) : undefined;
  return {
    name: "VIEW_CONTENT",
    properties: {
      item_ids: [id],
      // Omitted rather than zeroed when unknown: a zero-price view teaches the
      // optimiser that the product is worthless.
      ...(price !== undefined ? { price, currency: SNAP_CURRENCY } : {}),
      client_dedup_id: `vc-${id}`,
    },
    dedupeKey: null,
  };
}

export function buildSnapAddToCart(input: {
  slug: string;
  variantId?: string | null;
  quantity: number;
  price: number;
}): SnapEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const price = isPositive(input.price) ? money(input.price) : 0;
  // Matches TikTok's event id exactly, so the two platforms describe the same
  // action with the same key and a reconciliation can line them up.
  const variantKey = input.variantId ? `${id}::${input.variantId}` : id;
  return {
    name: "ADD_CART",
    properties: {
      item_ids: [id],
      price: money(price * quantity),
      currency: SNAP_CURRENCY,
      number_items: quantity,
      client_dedup_id: `atc-${variantKey}`,
    },
    dedupeKey: null,
  };
}

export function buildSnapCheckout(input: {
  itemCount: number;
  total: number;
  items?: { slug?: string | null }[];
}): SnapEvent | null {
  const total = money(input.total);
  if (!isPositive(total)) return null;
  const ids = (input.items ?? [])
    .map((item) => resolveContentId({ slug: item.slug }))
    .filter((id): id is string => Boolean(id));
  return {
    name: "START_CHECKOUT",
    properties: {
      ...(ids.length > 0 ? { item_ids: ids } : {}),
      price: total,
      currency: SNAP_CURRENCY,
      number_items: Math.max(1, Math.floor(Number(input.itemCount) || 1)),
      client_dedup_id: `ic-${input.itemCount}-${total}`,
    },
    dedupeKey: null,
  };
}

/**
 * The one event that represents money.
 *
 * Returns null unless the order is paid AND a positive amount settled — the
 * same two conditions TikTok's builder applies, read from the same order.
 */
export function buildSnapPurchase(order: PaidOrder): SnapEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const price = money(order.amountPaid);
  if (!isPositive(price)) return null;

  const ids = order.items
    .map((item) => resolveContentId({ slug: item.slug, productId: item.productId }))
    .filter((id): id is string => Boolean(id));

  return {
    name: "PURCHASE",
    properties: {
      // Falls back to naming the order, exactly as the TikTok builder does, so
      // a purchase is never reported without identifying anything.
      item_ids: ids.length > 0 ? ids : [`order-${order.orderId}`],
      price,
      currency: SNAP_CURRENCY,
      number_items: order.items.reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item.quantity) || 1)), 0) || 1,
      transaction_id: order.orderId,
      client_dedup_id: `purchase-${order.orderId}`,
    },
    dedupeKey: `snap-purchase:${order.orderId}`,
  };
}

export type SnapEmitter = (name: SnapEventName, properties: Record<string, unknown>) => void;

/** Send an event, honouring its dedupe key. Mirrors emitEvent for TikTok. */
export function emitSnapEvent(
  event: SnapEvent | null,
  emit: SnapEmitter,
  store: { has(key: string): boolean; mark(key: string): void },
): boolean {
  if (!event) return false;
  if (event.dedupeKey && store.has(event.dedupeKey)) return false;
  emit(event.name, event.properties);
  if (event.dedupeKey) store.mark(event.dedupeKey);
  return true;
}
