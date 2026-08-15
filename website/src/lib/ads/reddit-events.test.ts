import { describe, expect, it } from "vitest";
import {
  buildRedditAddToCart,
  buildRedditPurchase,
  buildRedditViewContent,
  emitRedditEvent,
  newConversionId,
} from "@/lib/ads/reddit-events";

// ---------------------------------------------------------------------------
// The payload shape is the part worth testing: a wrong field name is not an
// error anywhere, it is simply a conversion Reddit never counts.
// ---------------------------------------------------------------------------

describe("buildRedditViewContent", () => {
  it("carries the product and its price", () => {
    expect(buildRedditViewContent({ slug: "bpc-157", name: "BPC-157", category: "Peptides", price: 44.99 })).toEqual({
      name: "ViewContent",
      properties: { currency: "USD", products: [{ id: "bpc-157", name: "BPC-157", category: "Peptides" }], value: 44.99 },
    });
  });

  it("puts the variant in the product id, so a dose is identifiable", () => {
    const event = buildRedditViewContent({ slug: "bpc-157", variantId: "dose-1", price: 10 });
    expect(event?.properties.products?.[0].id).toBe("bpc-157::dose-1");
  });

  it("omits a price it does not have rather than sending zero", () => {
    // A zero-value view is a real number to Reddit's optimiser, and a wrong one.
    const event = buildRedditViewContent({ slug: "bpc-157", price: null });
    expect(event?.properties).not.toHaveProperty("value");
  });

  it("returns null without a slug, rather than an event about nothing", () => {
    expect(buildRedditViewContent({ slug: "" })).toBeNull();
  });
});

describe("buildRedditAddToCart", () => {
  it("reports the LINE value, not the unit price", () => {
    // Two vials is twice the intent of one; sending the unit price would
    // under-report every multi-unit add.
    const event = buildRedditAddToCart({ slug: "bpc-157", quantity: 3, price: 44.99 });
    expect(event?.properties.value).toBe(134.97);
    expect(event?.properties.itemCount).toBe(3);
  });

  it("defaults a missing quantity to one", () => {
    expect(buildRedditAddToCart({ slug: "bpc-157", price: 10 })?.properties.itemCount).toBe(1);
  });

  it("rounds to cents rather than emitting a float artefact", () => {
    expect(buildRedditAddToCart({ slug: "x", quantity: 3, price: 19.99 })?.properties.value).toBe(59.97);
  });

  it("ignores a negative or unusable quantity", () => {
    expect(buildRedditAddToCart({ slug: "x", quantity: -4, price: 10 })?.properties.itemCount).toBe(1);
  });
});

describe("buildRedditPurchase", () => {
  const order = {
    orderId: "order-123",
    total: 189.98,
    itemCount: 2,
    items: [
      { slug: "bpc-157", variantId: "dose-1", name: "BPC-157", category: "Peptides" },
      { slug: "bac-water", name: "BAC Water" },
    ],
  };

  it("uses the order id as the deduplication key", () => {
    // This is what lets a Conversions API leg be added later without doubling
    // the revenue Reddit reports.
    expect(buildRedditPurchase(order)?.properties.conversionId).toBe("order-123");
  });

  it("reports the money and the lines", () => {
    const event = buildRedditPurchase(order);
    expect(event?.name).toBe("Purchase");
    expect(event?.properties.currency).toBe("USD");
    expect(event?.properties.value).toBe(189.98);
    expect(event?.properties.itemCount).toBe(2);
    expect(event?.properties.products).toEqual([
      { id: "bpc-157::dose-1", name: "BPC-157", category: "Peptides" },
      { id: "bac-water", name: "BAC Water" },
    ]);
  });

  it("returns null without an order id", () => {
    expect(buildRedditPurchase({ orderId: "", total: 10 })).toBeNull();
  });

  it("still reports a purchase when the lines cannot be resolved", () => {
    // Losing the basket detail is a worse report; losing the conversion is a
    // worse business outcome.
    const event = buildRedditPurchase({ orderId: "order-9", total: 50, items: [] });
    expect(event?.properties.value).toBe(50);
    expect(event?.properties).not.toHaveProperty("products");
  });
});

describe("conversion ids — Reddit's deduplication key", () => {
  it("gives every occurrence its own id", () => {
    // A key that is stable per PRODUCT would make a shopper's second add of the
    // same item collapse into their first and vanish from the funnel.
    const ids = new Set(Array.from({ length: 200 }, () => newConversionId("atc")));
    expect(ids.size).toBe(200);
  });

  it("labels the id with the event it belongs to", () => {
    expect(newConversionId("vc").startsWith("vc-")).toBe(true);
    expect(newConversionId("atc").startsWith("atc-")).toBe(true);
  });

  it("still produces an id where crypto.randomUUID is missing", () => {
    // Some in-app browsers have no randomUUID; losing the id there would mean
    // the CAPI leg could never dedupe for those visitors.
    const original = globalThis.crypto?.randomUUID;
    try {
      if (globalThis.crypto) {
        // @ts-expect-error deliberately removing it for the fallback path
        globalThis.crypto.randomUUID = undefined;
      }
      const ids = new Set(Array.from({ length: 50 }, () => newConversionId("vc")));
      expect(ids.size).toBe(50);
      expect([...ids][0]).toMatch(/^vc-/);
    } finally {
      if (globalThis.crypto && original) globalThis.crypto.randomUUID = original;
    }
  });

  it("carries the id onto ViewContent and AddToCart when given one", () => {
    expect(buildRedditViewContent({ slug: "a", conversionId: "vc-1" })?.properties.conversionId).toBe("vc-1");
    expect(buildRedditAddToCart({ slug: "a", conversionId: "atc-1" })?.properties.conversionId).toBe("atc-1");
  });

  it("omits the field entirely rather than sending an empty one", () => {
    expect(buildRedditViewContent({ slug: "a" })?.properties).not.toHaveProperty("conversionId");
  });

  it("uses the STABLE order id for Purchase, so a refresh is not a second sale", () => {
    const first = buildRedditPurchase({ orderId: "order-7", total: 10 });
    const refreshed = buildRedditPurchase({ orderId: "order-7", total: 10 });
    expect(first?.properties.conversionId).toBe("order-7");
    expect(refreshed?.properties.conversionId).toBe(first?.properties.conversionId);
  });
});

describe("no identity ever rides on an event", () => {
  it("emits no email, phone or external id on any builder", () => {
    const events = [
      buildRedditViewContent({ slug: "a", price: 1 }),
      buildRedditAddToCart({ slug: "a", quantity: 1, price: 1 }),
      buildRedditPurchase({ orderId: "o", total: 1, items: [{ slug: "a" }] }),
    ];
    for (const event of events) {
      const serialised = JSON.stringify(event);
      expect(serialised).not.toMatch(/email|phone|externalId|external_id/i);
      expect(serialised).not.toContain("@");
    }
  });
});

describe("emitRedditEvent", () => {
  it("hands the name and properties to the emitter", () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const sent = emitRedditEvent(buildRedditAddToCart({ slug: "a", quantity: 1, price: 2 }), (name, properties) =>
      calls.push([name, properties]),
    );
    expect(sent).toBe(true);
    expect(calls[0][0]).toBe("AddToCart");
  });

  it("sends nothing for a null event, so a caller cannot invent one", () => {
    const calls: string[] = [];
    expect(emitRedditEvent(null, (name) => calls.push(name))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
