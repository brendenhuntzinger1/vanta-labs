import { describe, expect, it } from "vitest";
import {
  buildMetaAddToCart,
  buildMetaInitiateCheckout,
  buildMetaPurchase,
  buildMetaViewContent,
  emitMetaEvent,
  type MetaEvent,
} from "./meta-events";
import { buildAddToCart, buildInitiateCheckout, buildPurchase, buildViewContent } from "./tiktok-events";

function memoryStore() {
  const keys = new Set<string>();
  return { has: (key: string) => keys.has(key), mark: (key: string) => void keys.add(key), keys };
}

describe("ViewContent", () => {
  it("identifies the product by catalogue slug with the price it was shown at", () => {
    const event = buildMetaViewContent({ slug: "bpc-157", name: "BPC-157", price: 49.9, category: "peptides" });
    expect(event).toEqual({
      name: "ViewContent",
      properties: {
        content_ids: ["bpc-157"],
        content_type: "product",
        content_name: "BPC-157",
        content_category: "peptides",
        contents: [{ id: "bpc-157", quantity: 1, item_price: 49.9 }],
        value: 49.9,
        currency: "USD",
      },
      eventId: "vc-bpc-157",
      dedupeKey: null,
    });
  });

  it("omits value rather than sending zero when the price is unknown", () => {
    const event = buildMetaViewContent({ slug: "bpc-157" });
    expect(event?.properties).not.toHaveProperty("value");
    expect(event?.properties).not.toHaveProperty("currency");
    expect(event?.properties.contents).toEqual([{ id: "bpc-157", quantity: 1 }]);
  });

  it("refuses to describe nothing", () => {
    expect(buildMetaViewContent({ slug: "" })).toBeNull();
  });

  it("shares TikTok's event id so the platforms can be reconciled", () => {
    expect(buildMetaViewContent({ slug: "bpc-157" })?.eventId).toBe(buildViewContent({ slug: "bpc-157" })?.eventId);
  });
});

describe("AddToCart", () => {
  it("reports line value as unit price times quantity, rounded to cents", () => {
    const event = buildMetaAddToCart({ slug: "tb-500", variantId: "5mg", quantity: 3, price: 13.99 });
    expect(event?.properties.value).toBe(41.97);
    expect(event?.properties.contents).toEqual([{ id: "tb-500", quantity: 3, item_price: 13.99 }]);
    expect(event?.eventId).toBe("atc-tb-500::5mg");
    expect(event?.eventId).toBe(buildAddToCart({ slug: "tb-500", variantId: "5mg", quantity: 3, price: 13.99 })?.eventId);
  });

  it("treats a missing or nonsense quantity as one", () => {
    expect(buildMetaAddToCart({ slug: "tb-500", quantity: 0, price: 10 })?.properties.value).toBe(10);
    expect(buildMetaAddToCart({ slug: "tb-500", quantity: Number.NaN, price: 10 })?.properties.contents?.[0].quantity).toBe(1);
  });
});

describe("InitiateCheckout", () => {
  it("carries the cart total, the item count and each line", () => {
    const event = buildMetaInitiateCheckout({
      itemCount: 3,
      total: 129.5,
      items: [
        { slug: "bpc-157", quantity: 2, price: 49.9, category: "peptides" },
        { slug: "tb-500", quantity: 1, price: 29.7, category: "peptides" },
      ],
    });
    expect(event?.properties).toEqual({
      content_ids: ["bpc-157", "tb-500"],
      content_type: "product",
      contents: [
        { id: "bpc-157", quantity: 2, item_price: 49.9 },
        { id: "tb-500", quantity: 1, item_price: 29.7 },
      ],
      content_category: "peptides",
      value: 129.5,
      currency: "USD",
      num_items: 3,
    });
    expect(event?.eventId).toBe(buildInitiateCheckout({ itemCount: 3, total: 129.5 })?.eventId);
  });

  it("omits the category when the lines disagree, rather than picking one", () => {
    const event = buildMetaInitiateCheckout({
      itemCount: 2,
      total: 50,
      items: [{ slug: "a", category: "peptides" }, { slug: "b", category: "supplies" }],
    });
    expect(event?.properties).not.toHaveProperty("content_category");
  });

  it("reports nothing for an empty or zero-value cart", () => {
    expect(buildMetaInitiateCheckout({ itemCount: 0, total: 0 })).toBeNull();
  });
});

describe("Purchase", () => {
  const paid = {
    orderId: "VL-1001",
    isPaid: true,
    amountPaid: 88.8,
    items: [
      { slug: "bpc-157", productId: "p1", productName: "BPC-157", quantity: 2, unitPrice: 44.4 },
    ],
  };

  it("is built only from a paid order with a settled amount", () => {
    expect(buildMetaPurchase({ ...paid, isPaid: false })).toBeNull();
    expect(buildMetaPurchase({ ...paid, amountPaid: 0 })).toBeNull();
    expect(buildMetaPurchase({ ...paid, orderId: "" })).toBeNull();
  });

  it("reports the settled figure, not a recomputed sum", () => {
    const event = buildMetaPurchase({ ...paid, amountPaid: 70 }, { categories: ["peptides"] });
    expect(event?.properties.value).toBe(70);
    expect(event?.properties.num_items).toBe(2);
    expect(event?.properties.content_ids).toEqual(["bpc-157"]);
    expect(event?.properties.content_category).toBe("peptides");
    expect(event?.eventId).toBe("purchase-VL-1001");
    expect(event?.eventId).toBe(buildPurchase(paid)?.eventId);
    expect(event?.dedupeKey).toBe("meta-purchase:VL-1001");
  });

  it("falls back to the product id, and then to naming the order", () => {
    expect(buildMetaPurchase({ ...paid, items: [{ productId: "p1", quantity: 1 }] })?.properties.content_ids).toEqual(["p1"]);
    expect(buildMetaPurchase({ ...paid, items: [{ productName: "Only a name" }] })?.properties.content_ids).toEqual([
      "order-VL-1001",
    ]);
  });

  it("carries no identity field of any kind", () => {
    const keys = Object.keys(buildMetaPurchase(paid)?.properties ?? {});
    for (const key of keys) expect(key, `${key} looks like an identity field`).not.toMatch(/^(em|ph|fn|ln|external_id|email|phone)$/);
  });
});

describe("emitMetaEvent", () => {
  it("passes the eventID Meta dedupes on, and fires a keyed event once per browser", () => {
    const store = memoryStore();
    const sent: unknown[] = [];
    const event = buildMetaPurchase({ orderId: "VL-2", isPaid: true, amountPaid: 10, items: [] }) as MetaEvent;
    expect(emitMetaEvent(event, (...args) => void sent.push(args), store)).toBe(true);
    expect(emitMetaEvent(event, (...args) => void sent.push(args), store)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(["Purchase", event.properties, { eventID: "purchase-VL-2" }]);
  });

  it("does nothing for a null event", () => {
    expect(emitMetaEvent(null, () => undefined, memoryStore())).toBe(false);
  });
});
