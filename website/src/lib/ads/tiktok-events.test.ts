import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserFiredStore,
  buildAddToCart,
  buildPurchase,
  buildInitiateCheckout,
  buildViewContent,
  emitEvent,
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

  it("distinguishes variants of the same product", () => {
    const a = buildAddToCart({ slug: "bpc-157", variantId: "5mg", quantity: 1, price: 42.99 })!;
    const b = buildAddToCart({ slug: "bpc-157", variantId: "10mg", quantity: 1, price: 69.99 })!;
    expect(a.properties.contents?.[0].content_id).toBe("bpc-157::5mg");
    expect(b.properties.contents?.[0].content_id).toBe("bpc-157::10mg");
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
