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

/**
 * The canonical product identifier sent to TikTok.
 *
 * One scheme, used by every event, because TikTok joins a funnel on
 * `content_id`. Sending a slug on ViewContent and a database UUID on Purchase
 * gives two events that describe the same product and cannot be related to each
 * other — the platform sees a product that is viewed and never bought, and
 * another that is bought and never viewed.
 *
 * The product slug is that identifier. It is the catalogue's public key, it is
 * in the URL of the page being measured, it is stable, and it is present for
 * every product. SKU would be the conventional choice but is not populated
 * here, and a blank SKU is exactly the "Content ID is missing" warning.
 *
 * A variant never changes the id. Doses of one product are the same catalogue
 * item, and splitting them would reintroduce the join problem inside a single
 * product; the dose travels in `content_name`, where it is descriptive rather
 * than structural.
 *
 * Returns null rather than an empty string when nothing usable exists, so a
 * caller has to decide what to do about it instead of silently emitting a
 * content entry with no id — which is worse than sending no entry at all.
 */
export function resolveContentId(input: {
  slug?: string | null;
  /** Database id, used only when a slug genuinely is not available. */
  productId?: string | null;
}): string | null {
  const slug = String(input.slug ?? "").trim();
  if (slug) return slug;
  const productId = String(input.productId ?? "").trim();
  return productId || null;
}

/**
 * Drop entries TikTok would reject, and report nothing rather than nothing
 * useful. An empty `contents` array is omitted entirely by the callers below.
 */
function usableContents(contents: (TikTokContent | null)[]): TikTokContent[] {
  return contents.filter((entry): entry is TikTokContent => Boolean(entry && entry.content_id));
}

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
  name?: string | null;
  /** The dose or size chosen, e.g. "10mg". Descriptive, not part of the id. */
  variantLabel?: string | null;
  quantity: number;
  price: number;
}): TikTokEvent | null {
  const contentId = resolveContentId({ slug: input.slug });
  if (!contentId) return null;
  const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const price = isPositive(input.price) ? money(input.price) : 0;
  const name = [input.name, input.variantLabel && `(${input.variantLabel})`].filter(Boolean).join(" ") || undefined;
  // The event id still distinguishes variants. Two doses of one product are one
  // catalogue item to TikTok but two separate actions to us, and collapsing
  // them here would make the second add look like a duplicate of the first.
  const variantKey = input.variantId ? `${contentId}::${input.variantId}` : contentId;
  return {
    name: "AddToCart",
    properties: {
      content_type: "product",
      contents: [{ content_id: contentId, content_type: "product", content_name: name, quantity, price }],
      value: money(price * quantity),
      currency: CURRENCY,
    },
    eventId: `atc-${variantKey}`,
    // Adding the same item twice is two genuine adds, so this is not deduped.
    dedupeKey: null,
  };
}

/**
 * InitiateCheckout.
 *
 * This used to send a total and nothing else, which is what TikTok flags as
 * "Content ID is missing": an event that says money is at stake but not what
 * for. Without the cart's line items the platform cannot attribute the step to
 * any product, so the checkout stage of every product's funnel is blank.
 *
 * The lines come from the cart the shopper is actually looking at. The `value`
 * stays the checkout's own authoritative total — it includes shipping, tax and
 * discounts, so recomputing it from the lines would report a different number
 * from the one being charged.
 */
export function buildInitiateCheckout(input: {
  itemCount: number;
  total: number;
  items?: { slug?: string | null; productId?: string | null; name?: string | null; variantLabel?: string | null; quantity?: number | null; price?: number | null }[];
}): TikTokEvent | null {
  const total = money(input.total);
  if (!isPositive(total)) return null;

  const contents = usableContents(
    (input.items ?? []).map((item) => {
      const contentId = resolveContentId(item);
      if (!contentId) return null;
      const name = [item.name, item.variantLabel && `(${item.variantLabel})`].filter(Boolean).join(" ") || undefined;
      return {
        content_id: contentId,
        content_type: "product" as const,
        content_name: name,
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        price: isPositive(item.price) ? money(item.price) : undefined,
      };
    }),
  );

  return {
    name: "InitiateCheckout",
    properties: {
      // `content_type` goes with `contents` or not at all. Events Manager
      // showed the old payload — which sent a bare top-level `content_type` and
      // no contents — rendered as `contents: [{"content_type":"product", ...}]`:
      // TikTok synthesises a content entry from the top-level field, and that
      // entry has no id. So dropping `contents` alone does not avoid "Content
      // ID is missing"; the top-level field has to go with it.
      ...(contents.length > 0 ? { content_type: "product" as const, contents } : {}),
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
  items: {
    /**
     * The catalogue slug, resolved from the product this line refers to. Orders
     * store a database id, and sending that as the content id would give the
     * purchase a different identifier from the view and the add that led to it.
     */
    slug?: string | null;
    productId?: string | null;
    productName?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
  }[];
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

  // A product name is not an identifier and never becomes one here. It is not
  // stable, it is not what the other three events send, and using it would
  // produce a content id that silently stops matching the day a product is
  // renamed. A line with no slug and no product id is dropped instead.
  const contents = usableContents(
    order.items.map((item) => {
      const contentId = resolveContentId(item);
      if (!contentId) return null;
      return {
        content_id: contentId,
        content_type: "product" as const,
        content_name: item.productName ?? undefined,
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        price: isPositive(item.unitPrice) ? money(item.unitPrice) : undefined,
      };
    }),
  );

  return {
    name: "Purchase",
    properties: {
      // Paired with `contents` for the reason above: a lone top-level
      // `content_type` is turned into an id-less content entry by TikTok.
      ...(contents.length > 0 ? { content_type: "product" as const, contents } : {}),
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
export type AnalyticsLine = {
  slug?: string | null;
  name?: string | null;
  variantLabel?: string | null;
  quantity?: number | null;
  price?: number | null;
};

export type AnalyticsDetail = {
  eventType?: string;
  productSlug?: string;
  productName?: string | null;
  variantId?: string | null;
  variantLabel?: string | null;
  quantity?: number;
  price?: number;
  itemCount?: number;
  total?: number;
  /** Cart lines, carried so checkout can be attributed to real products. */
  items?: AnalyticsLine[];
};

export function mapAnalyticsDetail(detail: AnalyticsDetail | null | undefined): TikTokEvent | null {
  if (!detail?.eventType) return null;

  if (detail.eventType === "add_to_cart") {
    return buildAddToCart({
      slug: String(detail.productSlug ?? ""),
      variantId: detail.variantId ?? null,
      name: detail.productName ?? null,
      variantLabel: detail.variantLabel ?? null,
      quantity: Number(detail.quantity ?? 1),
      price: Number(detail.price ?? 0),
    });
  }

  if (detail.eventType === "begin_checkout") {
    return buildInitiateCheckout({
      itemCount: Number(detail.itemCount ?? 0),
      total: Number(detail.total ?? 0),
      items: detail.items ?? [],
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
