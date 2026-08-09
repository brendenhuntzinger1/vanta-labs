/**
 * TikTok ecommerce events — the pure half.
 *
 * Everything here is a plain function over plain data so the mapping between a
 * user action and what TikTok receives can be tested without a browser, a
 * pixel, or a network. The React components are thin wrappers around these.
 *
 * Three rules run through the file.
 *
 * **Never invent a number.** Every `value` traces to an authoritative figure —
 * a catalogue price for a view, the cart's own price for an add, the settled
 * `amount_paid` for a purchase. A helpful-looking estimate in a conversion
 * event is worse than no event: it trains the ad platform's optimiser on
 * fiction and inflates reported ROAS.
 *
 * **Purchase is gated on the backend's paid state, never on a URL.**
 * Reaching a thank-you page proves someone navigated, not that money moved.
 *
 * **One action, one event.** Idempotency keys are derived, not random, so a
 * refresh, a re-render, a back button or a forwarded confirmation link cannot
 * produce a second purchase.
 */

export type TikTokContent = {
  content_id: string;
  content_type: "product";
  content_name?: string;
  quantity?: number;
  price?: number;
};

export type TikTokEvent = {
  name: "ViewContent" | "AddToCart" | "InitiateCheckout" | "Purchase";
  properties: {
    contents?: TikTokContent[];
    content_type?: "product";
    value?: number;
    currency?: string;
  };
  /**
   * Stable per logical occurrence. TikTok uses it to collapse a browser event
   * and a server Events API event describing the same thing — so it must be
   * derived from the order or action, never randomly generated.
   */
  eventId: string;
  /** Storage key that makes this event fire at most once where that matters. */
  dedupeKey: string | null;
};

export const CURRENCY = "USD";

/** Round to cents. Floating-point cart maths otherwise sends 41.989999999999995. */
export function money(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function buildViewContent(input: {
  slug: string;
  name?: string;
  price?: number;
}): TikTokEvent | null {
  if (!input.slug) return null;
  const price = isPositive(input.price) ? money(input.price) : undefined;
  return {
    name: "ViewContent",
    properties: {
      content_type: "product",
      contents: [
        { content_id: input.slug, content_type: "product", content_name: input.name, quantity: 1, price },
      ],
      // Omitted rather than zeroed when a price is unknown: a zero-value
      // ViewContent tells the optimiser this product is worthless.
      ...(price !== undefined ? { value: price, currency: CURRENCY } : {}),
    },
    eventId: `vc-${input.slug}`,
    // A second view of the same product is a real second view.
    dedupeKey: null,
  };
}

export function buildAddToCart(input: {
  slug: string;
  variantId?: string | null;
  quantity: number;
  price: number;
}): TikTokEvent | null {
  if (!input.slug) return null;
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const price = isPositive(input.price) ? money(input.price) : 0;
  const contentId = input.variantId ? `${input.slug}::${input.variantId}` : input.slug;
  return {
    name: "AddToCart",
    properties: {
      content_type: "product",
      contents: [{ content_id: contentId, content_type: "product", quantity, price }],
      value: money(price * quantity),
      currency: CURRENCY,
    },
    eventId: `atc-${contentId}`,
    // Adding the same item twice is two genuine adds, so this is not deduped.
    dedupeKey: null,
  };
}

export function buildInitiateCheckout(input: {
  itemCount: number;
  total: number;
}): TikTokEvent | null {
  const total = money(input.total);
  if (!isPositive(total)) return null;
  return {
    name: "InitiateCheckout",
    properties: {
      content_type: "product",
      value: total,
      currency: CURRENCY,
    },
    eventId: `ic-${input.itemCount}-${total}`,
    dedupeKey: null,
  };
}

export type PaidOrder = {
  orderId: string;
  /** Must be the backend's own paid state. The caller does not get to decide. */
  isPaid: boolean;
  /** The settled figure, not a recomputed sum. */
  amountPaid: number;
  items: { productId?: string | null; productName?: string | null; quantity?: number | null; unitPrice?: number | null }[];
};

/**
 * The one event that represents money.
 *
 * Returns null unless the order is paid AND a positive amount actually settled.
 * Both conditions matter: a pending, failed, abandoned or manual-payment order
 * has `isPaid === false`, and a zero-value "purchase" is either a bug or a
 * fully-discounted order that TikTok should not learn revenue from.
 */
export function buildPurchase(order: PaidOrder): TikTokEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const value = money(order.amountPaid);
  if (!isPositive(value)) return null;

  const contents: TikTokContent[] = order.items
    .filter((item) => item.productId || item.productName)
    .map((item) => ({
      content_id: String(item.productId ?? item.productName),
      content_type: "product" as const,
      content_name: item.productName ?? undefined,
      quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
      price: isPositive(item.unitPrice) ? money(item.unitPrice) : undefined,
    }));

  return {
    name: "Purchase",
    properties: {
      content_type: "product",
      ...(contents.length > 0 ? { contents } : {}),
      value,
      currency: CURRENCY,
    },
    // Derived from the order so the browser event and a future server-side
    // Events API event for the same order collapse into one conversion.
    eventId: `purchase-${order.orderId}`,
    dedupeKey: `purchase:${order.orderId}`,
  };
}

/**
 * The store's own analytics broadcast, translated into a TikTok event.
 *
 * Extracted from the React listener so the exact mapping production runs can
 * be exercised by a test and by the admin health board, without dispatching
 * anything onto the shared `vanta:analytics` bus — which several unrelated
 * components (first-party analytics, the upsell prompt) also listen to, and
 * which a diagnostic has no business firing.
 *
 * Unknown event types return null rather than guessing: the bus carries more
 * kinds of event than the ad funnel needs, and forwarding all of them would
 * teach TikTok's optimiser from noise.
 */
export type AnalyticsDetail = {
  eventType?: string;
  productSlug?: string;
  variantId?: string | null;
  quantity?: number;
  price?: number;
  itemCount?: number;
  total?: number;
};

export function mapAnalyticsDetail(detail: AnalyticsDetail | null | undefined): TikTokEvent | null {
  if (!detail?.eventType) return null;

  if (detail.eventType === "add_to_cart") {
    return buildAddToCart({
      slug: String(detail.productSlug ?? ""),
      variantId: detail.variantId ?? null,
      quantity: Number(detail.quantity ?? 1),
      price: Number(detail.price ?? 0),
    });
  }

  if (detail.eventType === "begin_checkout") {
    return buildInitiateCheckout({
      itemCount: Number(detail.itemCount ?? 0),
      total: Number(detail.total ?? 0),
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "vl_ttq_sent:";

export type FiredStore = {
  has(key: string): boolean;
  mark(key: string): void;
};

/**
 * localStorage-backed record of what has already been sent.
 *
 * Survives refreshes, re-renders, back-navigation and re-opening a forwarded
 * confirmation link in the same browser — which covers every duplicate an
 * ecommerce funnel actually produces. It cannot cover a different browser or a
 * cleared profile; the true fix for that is server-side Events API dedup on
 * `event_id`, which is why the id is derived and stable.
 */
export function browserFiredStore(): FiredStore {
  return {
    has(key: string): boolean {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + key) !== null;
      } catch {
        // Storage blocked. Treat as "not yet sent" — a rare duplicate is a
        // better failure than silently never reporting a real purchase.
        return false;
      }
    },
    mark(key: string): void {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + key, String(Date.now()));
      } catch {
        /* no-op */
      }
    },
  };
}

export type Emitter = (name: string, properties: Record<string, unknown>, options: { event_id: string }) => void;

/**
 * Send an event, honouring its dedupe key.
 *
 * Returns whether it was sent, so callers and tests can assert that one user
 * action produced exactly one event.
 */
export function emitEvent(event: TikTokEvent | null, emit: Emitter, store: FiredStore): boolean {
  if (!event) return false;
  if (event.dedupeKey && store.has(event.dedupeKey)) return false;
  emit(event.name, event.properties, { event_id: event.eventId });
  if (event.dedupeKey) store.mark(event.dedupeKey);
  return true;
}
