/**
 * Omnisend events — the pure half.
 *
 * A deliberate mirror of ads/meta-events.ts: every builder here is a pure
 * function of its input, so a test can pin the exact field names Omnisend's
 * events API expects without stubbing a network or a database. A wrong name
 * does not error — Omnisend answers 2xx and the automation that keys on the
 * property simply never fires — so the names are the entire risk and the
 * suite beside this file pins each one.
 *
 * The rules that carry over from the ad legs:
 *
 * **Never invent a number.** Prices come from the catalogue or the order row,
 * never from the browser. The loader in orders.ts reads them from `orders` and
 * `order_items`; the cart hooks read them from the stored cart.
 *
 * **One action, one event.** `eventID` is derived from the thing it describes:
 * `${orderId}:${eventName}` for orders, the cart id plus a content hash for
 * carts, `${email}:${slug}:${hour}` for views. Omnisend deduplicates on the
 * pair (eventID, eventTime), so a retry of the same action collapses into one.
 *
 * **Identity is lowercased.** Omnisend's email identifiers are case-sensitive
 * (spec §5.1), so every builder normalises `contact.email` before it leaves.
 *
 * Deliberately NOT `server-only`: nothing here can reach the network on its
 * own. sendOmnisendEvent() reaches the gated transport through a dynamic
 * import so this module stays importable from a plain test, while a client
 * bundle that pulled it in would still fail the build the moment it tried to
 * resolve the server-only client.
 */

import { createHash } from "node:crypto";
import { money } from "@/lib/ads/tiktok-events";
import { buildCarrierTrackingUrl, carrierDisplayName } from "@/lib/tracking-url";

export type OmnisendLineItem = {
  /** The catalogue slug — the same id every other platform receives. */
  productID: string;
  productVariantID?: string;
  productTitle: string;
  productVariantTitle?: string;
  productPrice: number;
  productQuantity: number;
  productSKU?: string;
  productImageURL?: string;
  /** Per contact: carries the link token so the click lands past the account wall. */
  productURL: string;
  productCategories?: { id: string; title: string }[];
};

export type OmnisendEvent = {
  eventName: string;
  origin: "api";
  eventVersion: string;
  eventID: string;
  eventTime: string;
  contact: { email: string; phone?: string; firstName?: string; lastName?: string };
  properties: Record<string, unknown>;
};

/**
 * The version each system event is sent under (spec §5.2). Cart and checkout
 * events are unversioned; Omnisend's own example sends the empty string, and
 * so does this — the key is always present.
 */
export const EVENT_VERSIONS = {
  "viewed product": "v4",
  "added product to cart": "",
  "started checkout": "",
  "placed order": "v2",
  "paid for order": "v2",
  "order fulfilled": "v2",
  "order canceled": "v2",
  "order refunded": "v2",
} as const;

export type OmnisendEventName = keyof typeof EVENT_VERSIONS;
export type OmnisendCartEventName = "added product to cart" | "started checkout";
export type OmnisendOrderEventName = "placed order" | "paid for order" | "order fulfilled" | "order canceled" | "order refunded";

export type OmnisendOrder = {
  orderId: string;
  orderNumber?: string | null;
  /** `product` (or unset) is a sale; `membership` and `replacement` are not. */
  orderType?: string | null;
  /** Set on a reship; a replacement is not a purchase and yields no event. */
  replacementOf?: string | null;
  email: string;
  customerName?: string | null;
  phone?: string | null;
  currency: string;
  /** The settled figure from the row, never a recomputed sum. */
  amountPaid: number;
  subtotal: number;
  shipping: number;
  discount: number;
  tax: number;
  couponCode?: string | null;
  createdAt: string;
  paidAt?: string | null;
  shippedAt?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
  lineItems: OmnisendLineItem[];
  /** The canonical site origin, for orderStatusURL. */
  siteOrigin: string;
  /** Carried from the row for callers that gate on paid state; not sent. */
  paymentStatus?: string | null;
  fulfillmentStatus?: string | null;
};

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_CURRENCY = "USD";

/** Category ids for Omnisend: lowercase, non-alphanumerics collapsed to one dash, no leading or trailing dash. */
export function slugify(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * E.164 or nothing. Stored phones carry whatever punctuation the customer
 * typed; a ten-digit number is a US number for this store, eleven to fifteen
 * digits are taken as already carrying a country code. Anything else is
 * omitted rather than sent malformed, because Omnisend validates the contact
 * block as a whole and a bad phone would cost the event.
 */
function e164(phone: string | null | undefined): string | undefined {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

function splitName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function isoOf(value: string | null | undefined, fallbackMs: number): string {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString();
}

function wholeQuantity(value: unknown): number {
  return Math.max(1, Math.floor(Number(value) || 1));
}

/** Drop undefined and empty-string values so the JSON carries only what is known. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key] = entry;
  }
  return out as Partial<T>;
}

function normaliseLineItem(item: OmnisendLineItem): OmnisendLineItem {
  return {
    ...compact({
      productVariantID: item.productVariantID,
      productVariantTitle: item.productVariantTitle,
      productSKU: item.productSKU,
      productImageURL: item.productImageURL,
    }),
    productID: String(item.productID ?? "").trim(),
    productTitle: String(item.productTitle ?? "").trim(),
    productPrice: money(item.productPrice),
    productQuantity: wholeQuantity(item.productQuantity),
    productURL: String(item.productURL ?? ""),
    productCategories: (item.productCategories ?? []).map((category) => ({
      id: String(category.id ?? "").trim(),
      title: String(category.title ?? "").trim(),
    })),
  };
}

export function buildViewedProduct(input: {
  email: string;
  product: {
    slug: string;
    title: string;
    priceCents: number;
    currency?: string;
    url: string;
    imageUrl?: string | null;
    inStock: boolean;
    category?: string | null;
  };
  at?: number;
}): OmnisendEvent {
  const email = normaliseEmail(input.email);
  const at = input.at ?? Date.now();
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  const category = String(input.product.category ?? "").trim();
  const imageUrl = String(input.product.imageUrl ?? "").trim();
  return {
    eventName: "viewed product",
    origin: "api",
    eventVersion: EVENT_VERSIONS["viewed product"],
    // One view per contact, product and hour, whichever page load reports it.
    eventID: `${email}:${input.product.slug}:${new Date(hour).toISOString()}`,
    eventTime: new Date(at).toISOString(),
    contact: { email },
    properties: {
      product: {
        id: input.product.slug,
        title: input.product.title,
        price: money(input.product.priceCents / 100),
        currency: input.product.currency ?? DEFAULT_CURRENCY,
        url: input.product.url,
        ...(imageUrl ? { imageUrl } : {}),
        status: input.product.inStock ? "inStock" : "outOfStock",
        categories: category ? [{ id: slugify(category), title: category }] : [],
      },
    },
  };
}

export function buildCartEvent(input: {
  name: OmnisendCartEventName;
  email: string;
  cartId: string;
  currency?: string;
  lineItems: OmnisendLineItem[];
  addedItem?: OmnisendLineItem | null;
  checkoutUrl: string;
  at?: number;
}): OmnisendEvent {
  const email = normaliseEmail(input.email);
  const at = input.at ?? Date.now();
  const lineItems = input.lineItems.map(normaliseLineItem);
  const value = money(lineItems.reduce((sum, item) => sum + item.productPrice * item.productQuantity, 0));
  // The content hash: what is in the cart and how much of it. Same contents,
  // same id; a quantity change is a new event, which is what Omnisend's
  // abandonment flow needs to restart its timer.
  const contents = createHash("sha256")
    .update(JSON.stringify(lineItems.map((item) => [item.productID, item.productVariantID ?? "", item.productQuantity])))
    .digest("hex")
    .slice(0, 12);
  const addedItem =
    input.name === "added product to cart"
      ? input.addedItem
        ? normaliseLineItem(input.addedItem)
        : lineItems[lineItems.length - 1]
      : undefined;
  return {
    eventName: input.name,
    origin: "api",
    eventVersion: EVENT_VERSIONS[input.name],
    eventID: `${input.cartId}:${input.name}:${contents}`,
    eventTime: new Date(at).toISOString(),
    contact: { email },
    properties: {
      cartID: input.cartId,
      abandonedCheckoutURL: input.checkoutUrl,
      currency: input.currency ?? DEFAULT_CURRENCY,
      value,
      lineItems,
      ...(addedItem ? { addedItem } : {}),
    },
  };
}

/**
 * The order-shaped events. Returns null for anything that is not a sale — a
 * membership charge or a reship is not a purchase, and reporting one would
 * put the contact into a post-purchase flow for a product they did not buy.
 */
export function buildOrderEvent(input: {
  name: OmnisendOrderEventName;
  order: OmnisendOrder;
  at?: number;
}): OmnisendEvent | null {
  const { name, order } = input;
  if (order.orderType && order.orderType !== "product") return null;
  if (order.replacementOf) return null;
  const email = normaliseEmail(order.email);
  if (!email) return null;

  const now = input.at ?? Date.now();
  const fulfilled = name === "order fulfilled";
  const canceled = name === "order canceled";
  const refunded = name === "order refunded";

  const eventTime =
    name === "placed order" || name === "paid for order"
      ? isoOf(order.paidAt ?? order.createdAt, now)
      : fulfilled
        ? isoOf(order.shippedAt, now)
        : new Date(now).toISOString();

  const { firstName, lastName } = splitName(order.customerName);
  const phone = e164(order.phone);
  const address = compact({
    firstName,
    lastName,
    address1: order.address?.line1 ?? undefined,
    address2: order.address?.line2 ?? undefined,
    city: order.address?.city ?? undefined,
    state: order.address?.state ?? undefined,
    zip: order.address?.postalCode ?? undefined,
    country: order.address?.country ?? undefined,
    phone,
  });
  const lineItems = order.lineItems.map(normaliseLineItem);
  const couponCode = String(order.couponCode ?? "").trim();
  const trackingNumber = String(order.trackingNumber ?? "").trim();

  const tracking =
    fulfilled && trackingNumber
      ? compact({
          courierTitle: carrierDisplayName(order.carrier, trackingNumber) ?? String(order.carrier ?? "").trim(),
          // The carrier's own page when it can be identified; otherwise the
          // customer's order list, which is always a Vanta Labs URL.
          courierURL: buildCarrierTrackingUrl(order.carrier, trackingNumber) ?? `${order.siteOrigin}/account/orders`,
        })
      : undefined;

  return {
    eventName: name,
    origin: "api",
    eventVersion: EVENT_VERSIONS[name],
    eventID: `${order.orderId}:${name}`,
    eventTime,
    contact: compact({ email, phone, firstName, lastName }) as OmnisendEvent["contact"],
    properties: {
      orderID: order.orderId,
      orderNumber: order.orderNumber ?? order.orderId,
      createdAt: isoOf(order.createdAt, now),
      currency: order.currency || DEFAULT_CURRENCY,
      subTotalPrice: money(order.subtotal),
      totalPrice: money(order.amountPaid),
      totalDiscount: money(order.discount),
      totalTax: money(order.tax),
      shippingPrice: money(order.shipping),
      paymentStatus: refunded ? "refunded" : canceled ? "canceled" : "paid",
      fulfillmentStatus: fulfilled ? "fulfilled" : canceled ? "canceled" : "unfulfilled",
      discounts: couponCode ? [{ code: couponCode }] : [],
      lineItems,
      // The store collects one address; it is both the bill-to and ship-to.
      billingAddress: address,
      shippingAddress: address,
      orderStatusURL: `${order.siteOrigin}/account/orders`,
      ...(tracking ? { tracking } : {}),
      ...(refunded ? { refundedLineItems: lineItems } : {}),
    },
  };
}

/**
 * Send one event through the gated transport.
 *
 * The client is `server-only` and is loaded here, on demand, rather than at
 * the top of the file, so the builders above stay importable from a plain
 * test. Never throws: the callers are hooks inside after() and cron sweeps.
 */
export async function sendOmnisendEvent(event: OmnisendEvent): Promise<{ ok: boolean; status: number; error: string | null }> {
  try {
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "POST", path: "/events", body: event });
    return { ok: result.ok, status: result.status, error: result.error };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
