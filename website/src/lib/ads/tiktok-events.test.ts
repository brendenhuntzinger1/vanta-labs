import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserFiredStore,
  buildAddToCart,
  buildPurchase,
  buildInitiateCheckout,
  buildViewContent,
  emitEvent,
  mapAnalyticsDetail,
  resolveContentId,
  money,
  type FiredStore,
} from "./tiktok-events";

function memoryStore(): FiredStore {
  const seen = new Set<string>();
  return { has: (k) => seen.has(k), mark: (k) => void seen.add(k) };
}

describe("ViewContent", () => {
  it("carries the product, its price and the currency", () => {
    const event = buildViewContent({ slug: "bpc-157-5mg", name: "BPC-157 5mg", price: 42.99 })!;
    expect(event.name).toBe("ViewContent");
    expect(event.properties.value).toBe(42.99);
    expect(event.properties.currency).toBe("USD");
    expect(event.properties.contents).toEqual([
      { content_id: "bpc-157-5mg", content_type: "product", content_name: "BPC-157 5mg", quantity: 1, price: 42.99 },
    ]);
  });

  it("omits value entirely when the price is unknown rather than sending zero", () => {
    const event = buildViewContent({ slug: "bpc-157-5mg" })!;
    expect(event.properties).not.toHaveProperty("value");
    expect(event.properties.contents?.[0].price).toBeUndefined();
  });

  it("refuses to build without a product", () => {
    expect(buildViewContent({ slug: "" })).toBeNull();
  });
});

describe("AddToCart", () => {
  it("values the line, not the unit", () => {
    const event = buildAddToCart({ slug: "bpc-157-5mg", quantity: 3, price: 42.99 })!;
    expect(event.properties.value).toBe(128.97);
    expect(event.properties.contents?.[0]).toMatchObject({ content_id: "bpc-157-5mg", quantity: 3, price: 42.99 });
  });

  it("treats variants as one catalogue item but two distinct actions", () => {
    // The content id deliberately does not carry the variant: doses of one
    // product are the same catalogue item, and splitting them would stop the
    // adds joining the views and purchases of that product. The event id still
    // separates them, so a second dose is not mistaken for a duplicate.
    const a = buildAddToCart({ slug: "bpc-157", variantId: "5mg", quantity: 1, price: 42.99 })!;
    const b = buildAddToCart({ slug: "bpc-157", variantId: "10mg", quantity: 1, price: 69.99 })!;
    expect(a.properties.contents?.[0].content_id).toBe("bpc-157");
    expect(b.properties.contents?.[0].content_id).toBe("bpc-157");
    expect(a.eventId).toBe("atc-bpc-157::5mg");
    expect(b.eventId).toBe("atc-bpc-157::10mg");
  });

  it("is not deduped — adding the same item twice is two real adds", () => {
    const store = memoryStore();
    const emit = vi.fn();
    const build = () => buildAddToCart({ slug: "bpc-157", quantity: 1, price: 10 });
    expect(emitEvent(build(), emit, store)).toBe(true);
    expect(emitEvent(build(), emit, store)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("rounds floating-point cart arithmetic to cents", () => {
    expect(buildAddToCart({ slug: "x", quantity: 3, price: 13.33 })!.properties.value).toBe(39.99);
    expect(money(41.989999999999995)).toBe(41.99);
  });
});

describe("InitiateCheckout", () => {
  it("reports the cart total", () => {
    const event = buildInitiateCheckout({ itemCount: 2, total: 128.97 })!;
    expect(event.name).toBe("InitiateCheckout");
    expect(event.properties.value).toBe(128.97);
    expect(event.properties.currency).toBe("USD");
  });

  it("does not fire on an empty or zero-value cart", () => {
    expect(buildInitiateCheckout({ itemCount: 0, total: 0 })).toBeNull();
    expect(buildInitiateCheckout({ itemCount: 1, total: -5 })).toBeNull();
  });
});

describe("Purchase — must represent real paid revenue", () => {
  const paid = {
    orderId: "ord-123",
    isPaid: true,
    amountPaid: 128.97,
    items: [{ productId: "bpc-157-5mg", productName: "BPC-157 5mg", quantity: 3, unitPrice: 42.99 }],
  };

  it("builds from the settled amount and the real line items", () => {
    const event = buildPurchase(paid)!;
    expect(event.name).toBe("Purchase");
    expect(event.properties.value).toBe(128.97);
    expect(event.properties.currency).toBe("USD");
    expect(event.properties.contents).toEqual([
      { content_id: "bpc-157-5mg", content_type: "product", content_name: "BPC-157 5mg", quantity: 3, price: 42.99 },
    ]);
  });

  it("cannot fire for an order the backend has not marked paid", () => {
    expect(buildPurchase({ ...paid, isPaid: false })).toBeNull();
  });

  it("cannot fire for pending, failed, abandoned or unpaid-manual orders", () => {
    // Every one of these reaches the confirmation URL in the real system, and
    // every one of them has isPaid false — which is the only thing that gates it.
    for (const scenario of ["pending", "failed", "cancelled", "refunded", "awaiting_manual_payment"]) {
      expect(buildPurchase({ ...paid, isPaid: false }), scenario).toBeNull();
    }
  });

  it("cannot fire with no money actually settled", () => {
    expect(buildPurchase({ ...paid, amountPaid: 0 })).toBeNull();
    expect(buildPurchase({ ...paid, amountPaid: -10 })).toBeNull();
  });

  it("refuses an order with no id", () => {
    expect(buildPurchase({ ...paid, orderId: "" })).toBeNull();
  });

  it("still reports revenue when line items are missing", () => {
    const event = buildPurchase({ ...paid, items: [] })!;
    expect(event.properties.value).toBe(128.97);
    expect(event.properties).not.toHaveProperty("contents");
  });

  it("uses an event id derived from the order so a server event collapses into it", () => {
    expect(buildPurchase(paid)!.eventId).toBe("purchase-ord-123");
    expect(buildPurchase({ ...paid, orderId: "ord-999" })!.eventId).toBe("purchase-ord-999");
  });

  it("fires exactly once per order however many times the page is opened", () => {
    const store = memoryStore();
    const emit = vi.fn();
    expect(emitEvent(buildPurchase(paid), emit, store)).toBe(true);
    // refresh, back button, re-render, forwarded link…
    for (let i = 0; i < 5; i++) expect(emitEvent(buildPurchase(paid), emit, store)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("Purchase", expect.objectContaining({ value: 128.97 }), { event_id: "purchase-ord-123" });
  });

  it("keeps separate orders separate", () => {
    const store = memoryStore();
    const emit = vi.fn();
    emitEvent(buildPurchase(paid), emit, store);
    emitEvent(buildPurchase({ ...paid, orderId: "ord-456" }), emit, store);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

// Tests run in the node environment, so the browser store gets a minimal
// stand-in rather than pulling in jsdom for two assertions.
function installStorage(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  const storage: Storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    ...impl,
  } as Storage;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return storage;
}

describe("idempotency store", () => {
  beforeEach(() => {
    installStorage();
  });

  it("survives a fresh store instance, which is what a refresh looks like", () => {
    browserFiredStore().mark("purchase:ord-1");
    expect(browserFiredStore().has("purchase:ord-1")).toBe(true);
    expect(browserFiredStore().has("purchase:ord-2")).toBe(false);
  });

  it("degrades to sending rather than silently dropping when storage is blocked", () => {
    installStorage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    // A rare duplicate is a better failure than never reporting a real purchase.
    expect(browserFiredStore().has("purchase:ord-1")).toBe(false);
    expect(() => browserFiredStore().mark("purchase:ord-1")).not.toThrow();
  });
});

describe("emitEvent", () => {
  it("sends nothing for a null event", () => {
    const emit = vi.fn();
    expect(emitEvent(null, emit, memoryStore())).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("passes the event id through as a dedupe option", () => {
    const emit = vi.fn();
    emitEvent(buildViewContent({ slug: "x", price: 1 }), emit, memoryStore());
    expect(emit).toHaveBeenCalledWith("ViewContent", expect.any(Object), { event_id: "vc-x" });
  });
});

describe("mapping the store's analytics broadcast", () => {
  it("turns an add to cart into AddToCart with the cart's own numbers", () => {
    const event = mapAnalyticsDetail({ eventType: "add_to_cart", productSlug: "bpc-157", quantity: 2, price: 42.99 });
    expect(event?.name).toBe("AddToCart");
    expect(event?.properties.value).toBe(85.98);
    expect(event?.eventId).toBe("atc-bpc-157");
  });

  it("turns starting checkout into InitiateCheckout", () => {
    const event = mapAnalyticsDetail({ eventType: "begin_checkout", itemCount: 3, total: 129.5 });
    expect(event?.name).toBe("InitiateCheckout");
    expect(event?.properties.value).toBe(129.5);
  });

  it("ignores the other traffic on the shared bus", () => {
    // The bus carries more than the ad funnel needs. Forwarding page views or
    // cart removals would teach the optimiser from noise.
    for (const eventType of ["page_view", "session_start", "remove_from_cart", "purchase"]) {
      expect(mapAnalyticsDetail({ eventType })).toBeNull();
    }
    expect(mapAnalyticsDetail(null)).toBeNull();
    expect(mapAnalyticsDetail({})).toBeNull();
  });

  it("refuses a checkout with no value rather than reporting a zero", () => {
    expect(mapAnalyticsDetail({ eventType: "begin_checkout", itemCount: 1, total: 0 })).toBeNull();
  });
});

describe("content identification", () => {
  const line = { slug: "bpc-157", name: "BPC-157", variantLabel: "10mg", quantity: 1, price: 42.99 };

  it("sends contents with a content_id on InitiateCheckout", () => {
    // The regression: TikTok flagged "Content ID is missing in your events"
    // because checkout reported a value and no product at all.
    const event = buildInitiateCheckout({ itemCount: 1, total: 49.99, items: [line] });
    expect(event?.properties.contents?.[0].content_id).toBe("bpc-157");
    expect(event?.properties.contents?.[0].content_type).toBe("product");
  });

  it("keeps the checkout's own total rather than recomputing it from the lines", () => {
    // The total includes shipping, tax and discounts. Summing the lines would
    // report a different number from the one being charged.
    const event = buildInitiateCheckout({ itemCount: 2, total: 105.5, items: [line, { ...line, slug: "tb-500" }] });
    expect(event?.properties.value).toBe(105.5);
  });

  it("drops content_type along with contents when nothing is identifiable", () => {
    // Observed in Events Manager: a payload with a bare top-level content_type
    // and no contents is rendered by TikTok as
    // contents: [{"content_type":"product","currency":"USD"}] — they synthesise
    // an entry from the top-level field, and it has no id. So omitting contents
    // is not enough on its own to clear "Content ID is missing".
    const event = buildInitiateCheckout({ itemCount: 1, total: 20, items: [{ name: "Mystery", quantity: 1 }] });
    expect(event?.properties.contents).toBeUndefined();
    expect(event?.properties.content_type).toBeUndefined();
    // Still a real checkout worth reporting — the value is authoritative.
    expect(event?.properties.value).toBe(20);
    expect(event?.properties.currency).toBe("USD");
  });

  it("does the same for a purchase whose lines cannot be identified", () => {
    const event = buildPurchase({
      orderId: "ord-x",
      isPaid: true,
      amountPaid: 30,
      items: [{ productName: "Name Only", quantity: 1, unitPrice: 30 }],
    });
    expect(event?.properties.contents).toBeUndefined();
    expect(event?.properties.content_type).toBeUndefined();
    expect(event?.properties.value).toBe(30);
  });

  it("drops only the unidentifiable line, keeping the rest", () => {
    const event = buildInitiateCheckout({ itemCount: 2, total: 60, items: [line, { name: "Mystery" }] });
    expect(event?.properties.contents).toHaveLength(1);
  });

  it("uses one identifier for the same product across the whole funnel", () => {
    // TikTok joins a funnel on content_id. A slug on the view and a database
    // id on the purchase describes one product as two.
    const view = buildViewContent({ slug: "bpc-157", name: "BPC-157", price: 42.99 });
    const add = buildAddToCart({ slug: "bpc-157", variantId: "dose-10mg", quantity: 1, price: 42.99 });
    const checkout = buildInitiateCheckout({ itemCount: 1, total: 42.99, items: [line] });
    const purchase = buildPurchase({
      orderId: "ord-1",
      isPaid: true,
      amountPaid: 42.99,
      items: [{ slug: "bpc-157", productId: "3f9c0b7e-uuid", productName: "BPC-157 (10mg)", quantity: 1, unitPrice: 42.99 }],
    });

    const ids = [view, add, checkout, purchase].map((e) => e?.properties.contents?.[0].content_id);
    expect(ids).toEqual(["bpc-157", "bpc-157", "bpc-157", "bpc-157"]);
  });

  it("does not fold the variant into the id, but keeps events distinguishable", () => {
    const tenMg = buildAddToCart({ slug: "bpc-157", variantId: "dose-10", quantity: 1, price: 40 });
    const fiveMg = buildAddToCart({ slug: "bpc-157", variantId: "dose-5", quantity: 1, price: 25 });
    expect(tenMg?.properties.contents?.[0].content_id).toBe(fiveMg?.properties.contents?.[0].content_id);
    // Same catalogue item, two genuine actions — the event ids must differ or
    // the second add looks like a duplicate of the first.
    expect(tenMg?.eventId).not.toBe(fiveMg?.eventId);
  });

  it("carries the dose as a name, where it is descriptive rather than structural", () => {
    const event = buildAddToCart({ slug: "bpc-157", name: "BPC-157", variantLabel: "10mg", quantity: 1, price: 40 });
    expect(event?.properties.contents?.[0].content_name).toBe("BPC-157 (10mg)");
  });

  it("falls back to the product id, never to the product name", () => {
    // A name is not an identifier: it is not stable, and it stops matching the
    // day someone renames a product.
    const event = buildPurchase({
      orderId: "ord-2",
      isPaid: true,
      amountPaid: 10,
      items: [{ productId: "uuid-only", productName: "Some Product", quantity: 1, unitPrice: 10 }],
    });
    expect(event?.properties.contents?.[0].content_id).toBe("uuid-only");

    const nameOnly = buildPurchase({
      orderId: "ord-3",
      isPaid: true,
      amountPaid: 10,
      items: [{ productName: "Name Only", quantity: 1, unitPrice: 10 }],
    });
    expect(nameOnly?.properties.contents).toBeUndefined();
    // Still a conversion — the money is real even when the line is not identifiable.
    expect(nameOnly?.properties.value).toBe(10);
  });

  it("resolves an id from a slug, then an id, then nothing", () => {
    expect(resolveContentId({ slug: "a", productId: "b" })).toBe("a");
    expect(resolveContentId({ slug: "  ", productId: "b" })).toBe("b");
    expect(resolveContentId({ slug: null, productId: null })).toBeNull();
    expect(resolveContentId({ slug: "  padded  " })).toBe("padded");
  });
});

describe("payload audit — every field TikTok checks", () => {
  const events = () => [
    buildViewContent({ slug: "bpc-157", name: "BPC-157", price: 42.99 }),
    buildAddToCart({ slug: "bpc-157", name: "BPC-157", variantLabel: "10mg", quantity: 2, price: 42.99 }),
    buildInitiateCheckout({
      itemCount: 1,
      total: 85.98,
      items: [{ slug: "bpc-157", name: "BPC-157", quantity: 2, price: 42.99 }],
    }),
    buildPurchase({
      orderId: "ord-9",
      isPaid: true,
      amountPaid: 85.98,
      items: [{ slug: "bpc-157", productId: "uuid", productName: "BPC-157", quantity: 2, unitPrice: 42.99 }],
    }),
  ];

  it("populates content_id, content_type, currency, value and event_id on all four", () => {
    for (const event of events()) {
      expect(event).not.toBeNull();
      expect(event!.properties.contents?.length).toBeGreaterThan(0);
      for (const content of event!.properties.contents!) {
        expect(content.content_id).toBeTruthy();
        expect(content.content_id.trim()).toBe(content.content_id);
        expect(content.content_type).toBe("product");
      }
      expect(event!.properties.currency).toBe("USD");
      expect(event!.properties.value).toBeGreaterThan(0);
      expect(event!.eventId).toBeTruthy();
    }
  });

  it("gives each event a distinct, non-random id that survives a repeat", () => {
    const first = events().map((e) => e!.eventId);
    const second = events().map((e) => e!.eventId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("never sends a value that is not a rounded number of cents", () => {
    for (const event of events()) {
      expect(event!.properties.value).toBe(Math.round(event!.properties.value! * 100) / 100);
    }
  });
});
