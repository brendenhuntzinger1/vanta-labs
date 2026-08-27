/**
 * Google Ads ecommerce events — the pure half.
 *
 * A deliberate mirror of snap-events.ts and tiktok-events.ts: same funnel, same
 * authoritative numbers, same derived-not-random identifiers. Four ad platforms
 * disagreeing about the same order is a reporting problem nobody notices until
 * they are reconciling spend, so all four are built from the same inputs and
 * the same rules.
 *
 * Three things carry over unchanged because they are the rules that matter:
 *
 * **Never invent a number.** Every price traces to a catalogue or settled
 * figure.
 *
 * **Purchase is gated on the backend's paid state, never on a URL.**
 *
 * **One action, one event.** `transaction_id` is derived from the order it
 * describes, which is what lets Google collapse a browser event and an
 * Enhanced Conversions event into one conversion instead of two.
 *
 * The product identifier is the SAME catalogue slug TikTok, Snap and Reddit
 * receive. Reporting a product as `bpc-157` on one platform and something else
 * on another makes cross-channel comparison impossible for no benefit.
 *
 * ON SHIPPING AND TAX. Google's purchase event accepts optional `shipping` and
 * `tax` parameters and they are deliberately not sent. `PaidOrder` carries
 * neither, and the only ways to produce them would be to add a second read of
 * the order or to recompute them here — the second pricing calculation this
 * codebase does not permit. `value` is `amountPaid`, the settled total, which
 * is inclusive of both by construction and is the figure bidding uses. A wrong
 * breakdown is worse than an absent one.
 *
 * ON THE IDENTITY FIELDS. Google's Enhanced Conversions documentation offers
 * both raw and hashed forms. Only the hashed form is accepted here, and
 * `hashedOnly` enforces it structurally: a value that is not a 64-character
 * SHA-256 digest is dropped rather than sent. The digests are produced
 * server-side by google-matching.ts. This module never sees a raw address.
 */

import { money, resolveContentId, type PaidOrder } from "./tiktok-events";
import type { GoogleIdentity } from "./google-matching";

/** Google's standard ecommerce event names. Lowercase snake_case. */
export type GoogleEventName = "page_view" | "view_item" | "add_to_cart" | "begin_checkout" | "purchase";

export type GoogleItem = {
  item_id: string;
  item_name?: string;
  quantity?: number;
  price?: number;
};

export type GoogleEvent = {
  name: GoogleEventName;
  params: {
    value?: number;
    currency?: string;
    /** Google's deduplication key for a purchase. Derived, never random. */
    transaction_id?: string;
    items?: GoogleItem[];
  };
  /** Enhanced Conversions identity. Digests only — see hashedOnly. */
  userData?: {
    sha256_email_address?: string;
    sha256_phone_number?: string;
  };
  /** Storage key that makes this event fire at most once where that matters. */
  dedupeKey: string | null;
};

export const GOOGLE_CURRENCY = "USD";

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function countOf(quantity: unknown): number {
  return Math.max(1, Math.floor(Number(quantity) || 1));
}

/**
 * Accepts a SHA-256 digest and nothing else.
 *
 * The point is not validation for its own sake. Google's own setup guides show
 * `email: 'INSERT_USER_EMAIL'` in this position, and the failure mode of
 * pasting that is silent: a raw customer address goes to a third party on every
 * event and nothing looks broken. Refusing anything that is not 64 hex
 * characters means the mistake cannot be made here — a raw address is dropped,
 * not forwarded.
 */
export function hashedOnly(value: string | null | undefined): string | undefined {
  const digest = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function userDataFrom(identity: GoogleIdentity | null | undefined): GoogleEvent["userData"] {
  if (!identity) return undefined;
  const email = hashedOnly(identity.hashedEmail);
  const phone = hashedOnly(identity.hashedPhone);
  if (!email && !phone) return undefined;
  return {
    ...(email ? { sha256_email_address: email } : {}),
    ...(phone ? { sha256_phone_number: phone } : {}),
  };
}

export function buildGoogleViewItem(input: {
  slug: string;
  price?: number;
  name?: string | null;
}): GoogleEvent | null {
  const itemId = resolveContentId({ slug: input.slug });
  if (!itemId) return null;

  return {
    name: "view_item",
    params: {
      currency: GOOGLE_CURRENCY,
      ...(isPositive(input.price) ? { value: money(input.price) } : {}),
      items: [
        {
          item_id: itemId,
          ...(input.name ? { item_name: input.name } : {}),
          ...(isPositive(input.price) ? { price: money(input.price) } : {}),
        },
      ],
    },
    dedupeKey: null,
  };
}

export function buildGoogleAddToCart(input: {
  slug: string;
  price?: number;
  quantity?: number;
  name?: string | null;
}): GoogleEvent | null {
  const itemId = resolveContentId({ slug: input.slug });
  if (!itemId) return null;

  const quantity = countOf(input.quantity);
  const price = isPositive(input.price) ? money(input.price) : undefined;

  return {
    name: "add_to_cart",
    params: {
      currency: GOOGLE_CURRENCY,
      ...(price !== undefined ? { value: money(price * quantity) } : {}),
      items: [
        {
          item_id: itemId,
          ...(input.name ? { item_name: input.name } : {}),
          quantity,
          ...(price !== undefined ? { price } : {}),
        },
      ],
    },
    dedupeKey: null,
  };
}

export function buildGoogleBeginCheckout(input: {
  value: number;
  items: { slug: string; quantity?: number; price?: number; name?: string | null }[];
}): GoogleEvent | null {
  const value = money(input.value);
  if (!isPositive(value)) return null;

  const items = input.items
    .map((item) => {
      const itemId = resolveContentId({ slug: item.slug });
      if (!itemId) return null;
      return {
        item_id: itemId,
        ...(item.name ? { item_name: item.name } : {}),
        quantity: countOf(item.quantity),
        ...(isPositive(item.price) ? { price: money(item.price) } : {}),
      };
    })
    .filter((item): item is GoogleItem => item !== null);

  if (items.length === 0) return null;

  return {
    name: "begin_checkout",
    params: { value, currency: GOOGLE_CURRENCY, items },
    dedupeKey: null,
  };
}

/**
 * The one event that represents money.
 *
 * Returns null unless the order is paid AND a positive amount actually settled.
 * Both conditions matter: a pending, failed, abandoned or manual-payment order
 * has `isPaid === false`, and a zero-value "purchase" is either a bug or a
 * fully-discounted order that Google should not learn revenue from.
 */
export function buildGooglePurchase(
  order: PaidOrder,
  options?: { identity?: GoogleIdentity | null },
): GoogleEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const value = money(order.amountPaid);
  if (!isPositive(value)) return null;

  // A product name is not an identifier and never becomes one here. It is not
  // stable, it is not what the other three events send, and using it would
  // produce an item id that silently stops matching the day a product is
  // renamed. A line with no slug and no product id is dropped instead.
  const resolved = order.items
    .map((item) => {
      const itemId = resolveContentId({ slug: item.slug, productId: item.productId });
      if (!itemId) return null;
      return {
        item_id: itemId,
        ...(item.productName ? { item_name: item.productName } : {}),
        quantity: countOf(item.quantity),
        ...(isPositive(item.unitPrice) ? { price: money(item.unitPrice) } : {}),
      };
    })
    .filter((item): item is GoogleItem => item !== null);

  // A purchase always carries an item, even when no line resolved. Dropping the
  // event would cost the whole conversion; identifying the order itself costs
  // nothing and is legible as the anomaly it is if it ever appears.
  const items: GoogleItem[] =
    resolved.length > 0
      ? resolved
      : [{ item_id: `order-${order.orderId}`, item_name: "Order (line items unresolved)", quantity: 1, price: value }];

  const userData = userDataFrom(options?.identity);

  return {
    name: "purchase",
    params: {
      value,
      currency: GOOGLE_CURRENCY,
      transaction_id: order.orderId,
      items,
    },
    ...(userData ? { userData } : {}),
    dedupeKey: `google-purchase:${order.orderId}`,
  };
}

export type GoogleEmitter = (name: GoogleEventName, params: Record<string, unknown>) => void;

/** Send an event, honouring its dedupe key. Mirrors emitSnapEvent. */
export function emitGoogleEvent(
  event: GoogleEvent | null,
  emit: GoogleEmitter,
  store: { has(key: string): boolean; mark(key: string): void },
): boolean {
  if (!event) return false;
  if (event.dedupeKey && store.has(event.dedupeKey)) return false;
  emit(event.name, event.params);
  if (event.dedupeKey) store.mark(event.dedupeKey);
  return true;
}
