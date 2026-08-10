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
 *
 * ON THE IDENTITY FIELDS. Snapchat's parameter reference offers both raw and
 * hashed forms of email and phone (`user_email` / `user_hashed_email`). Only
 * the hashed form is accepted here, and `hashedOnly` enforces it structurally:
 * a value that is not a 64-character SHA-256 digest is dropped rather than
 * sent. That makes handing Snap a raw address impossible by accident, not
 * merely discouraged — the digests are produced server-side by
 * advanced-matching.ts, which is the same path TikTok's Advanced Matching
 * already uses.
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
    /** 1 when the transaction completed. Only ever set on a settled order. */
    success?: 0 | 1;
    /** Whether a payment credential is already on file at this point. */
    payment_info_available?: 0 | 1;
    /** SHA-256 digest. Never a raw address — see hashedOnly. */
    user_hashed_email?: string;
    /** SHA-256 digest of the E.164 digits. Never a raw number. */
    user_hashed_phone_number?: string;
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

/**
 * Accepts a SHA-256 digest and nothing else.
 *
 * The point is not validation for its own sake. Snap's own template invites
 * `'user_email': 'INSERT_USER_EMAIL'`, and the failure mode of pasting that is
 * silent: a raw customer address goes to a third party on every event and
 * nothing looks broken. Refusing anything that is not 64 hex characters means
 * the mistake cannot be made here — a raw address is dropped, not forwarded.
 */
export function hashedOnly(value: string | null | undefined): string | undefined {
  const digest = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

/**
 * Snap takes one category per event, not one per line.
 *
 * With a single distinct category that is unambiguous; with several, any
 * choice would misdescribe the rest, so the field is omitted rather than
 * guessed at.
 */
function singleCategory(values: (string | null | undefined)[]): string | undefined {
  const distinct = new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

/** Hashed identity, shared by the events that legitimately know the customer. */
export type SnapIdentity = {
  /** SHA-256 of the trimmed, lowercased address. */
  hashedEmail?: string | null;
  /** SHA-256 of the E.164 digits, no leading plus. */
  hashedPhone?: string | null;
};

function identityProperties(identity?: SnapIdentity | null) {
  const email = hashedOnly(identity?.hashedEmail);
  const phone = hashedOnly(identity?.hashedPhone);
  return {
    ...(email ? { user_hashed_email: email } : {}),
    ...(phone ? { user_hashed_phone_number: phone } : {}),
  };
}

export function buildSnapViewContent(input: { slug: string; price?: number; category?: string | null }): SnapEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const price = isPositive(input.price) ? money(input.price) : undefined;
  const category = singleCategory([input.category]);
  return {
    name: "VIEW_CONTENT",
    properties: {
      item_ids: [id],
      ...(category ? { item_category: category } : {}),
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
  category?: string | null;
}): SnapEvent | null {
  const id = resolveContentId({ slug: input.slug });
  if (!id) return null;
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const price = isPositive(input.price) ? money(input.price) : 0;
  const category = singleCategory([input.category]);
  // Matches TikTok's event id exactly, so the two platforms describe the same
  // action with the same key and a reconciliation can line them up.
  const variantKey = input.variantId ? `${id}::${input.variantId}` : id;
  return {
    name: "ADD_CART",
    properties: {
      item_ids: [id],
      ...(category ? { item_category: category } : {}),
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
  items?: { slug?: string | null; category?: string | null }[];
}): SnapEvent | null {
  const total = money(input.total);
  if (!isPositive(total)) return null;
  const ids = (input.items ?? [])
    .map((item) => resolveContentId({ slug: item.slug }))
    .filter((id): id is string => Boolean(id));
  const category = singleCategory((input.items ?? []).map((item) => item.category));
  return {
    name: "START_CHECKOUT",
    properties: {
      ...(ids.length > 0 ? { item_ids: ids } : {}),
      ...(category ? { item_category: category } : {}),
      price: total,
      currency: SNAP_CURRENCY,
      number_items: Math.max(1, Math.floor(Number(input.itemCount) || 1)),
      // Always 0, and that is a fact rather than a default: the card is entered
      // on the payment provider's hosted page after this event, and this store
      // holds no card on file for anyone. If saved payment methods are ever
      // added, this has to become a real lookup instead of a constant.
      payment_info_available: 0,
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
export function buildSnapPurchase(
  order: PaidOrder,
  options?: { categories?: (string | null | undefined)[]; identity?: SnapIdentity | null },
): SnapEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const price = money(order.amountPaid);
  if (!isPositive(price)) return null;

  const ids = order.items
    .map((item) => resolveContentId({ slug: item.slug, productId: item.productId }))
    .filter((id): id is string => Boolean(id));
  const category = singleCategory(options?.categories ?? []);

  return {
    name: "PURCHASE",
    properties: {
      // Falls back to naming the order, exactly as the TikTok builder does, so
      // a purchase is never reported without identifying anything.
      item_ids: ids.length > 0 ? ids : [`order-${order.orderId}`],
      ...(category ? { item_category: category } : {}),
      price,
      currency: SNAP_CURRENCY,
      number_items: order.items.reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item.quantity) || 1)), 0) || 1,
      transaction_id: order.orderId,
      // Unconditionally 1 because the two lines above already guarantee it: an
      // order that is not paid, or that settled nothing, produced a null event
      // and never reached here. There is no path that reports success: 0.
      success: 1,
      ...identityProperties(options?.identity),
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
