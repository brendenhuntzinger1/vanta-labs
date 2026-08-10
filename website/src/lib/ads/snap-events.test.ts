import { describe, expect, it, vi } from "vitest";
import {
  buildSnapAddToCart,
  buildSnapCheckout,
  buildSnapPurchase,
  buildSnapViewContent,
  emitSnapEvent,
  hashedOnly,
  SNAP_CURRENCY,
} from "./snap-events";
import {
  buildAddToCart,
  buildInitiateCheckout,
  buildPurchase,
  buildViewContent,
  type FiredStore,
} from "./tiktok-events";

function memoryStore(): FiredStore {
  const seen = new Set<string>();
  return { has: (k) => seen.has(k), mark: (k) => void seen.add(k) };
}

describe("VIEW_CONTENT", () => {
  it("carries the product, its price and the currency", () => {
    const event = buildSnapViewContent({ slug: "bpc-157-5mg", price: 42.99 })!;
    expect(event.name).toBe("VIEW_CONTENT");
    expect(event.properties.item_ids).toEqual(["bpc-157-5mg"]);
    expect(event.properties.price).toBe(42.99);
    expect(event.properties.currency).toBe(SNAP_CURRENCY);
  });

  it("omits the price entirely when it is unknown rather than sending zero", () => {
    // A zero-price view teaches the optimiser the product is worthless, which
    // is a worse lie than saying nothing about its value.
    const event = buildSnapViewContent({ slug: "bpc-157-5mg" })!;
    expect(event.properties).not.toHaveProperty("price");
    expect(event.properties).not.toHaveProperty("currency");
    expect(event.properties.item_ids).toEqual(["bpc-157-5mg"]);
  });

  it("refuses to build without a product", () => {
    expect(buildSnapViewContent({ slug: "" })).toBeNull();
    expect(buildSnapViewContent({ slug: "   " })).toBeNull();
  });
});

describe("ADD_CART", () => {
  it("values the line, not the unit", () => {
    const event = buildSnapAddToCart({ slug: "bpc-157-5mg", quantity: 3, price: 42.99 })!;
    expect(event.name).toBe("ADD_CART");
    expect(event.properties.price).toBe(128.97);
    expect(event.properties.number_items).toBe(3);
  });

  it("treats doses as one catalogue item but two distinct actions", () => {
    const a = buildSnapAddToCart({ slug: "bpc-157", variantId: "5mg", quantity: 1, price: 42.99 })!;
    const b = buildSnapAddToCart({ slug: "bpc-157", variantId: "10mg", quantity: 1, price: 69.99 })!;
    expect(a.properties.item_ids).toEqual(["bpc-157"]);
    expect(b.properties.item_ids).toEqual(["bpc-157"]);
    expect(a.properties.client_dedup_id).not.toBe(b.properties.client_dedup_id);
  });

  it("rounds floating-point cart arithmetic to cents", () => {
    expect(buildSnapAddToCart({ slug: "x", quantity: 3, price: 13.33 })!.properties.price).toBe(39.99);
  });

  it("is not deduped — adding the same item twice is two real adds", () => {
    const store = memoryStore();
    const emit = vi.fn();
    const build = () => buildSnapAddToCart({ slug: "bpc-157", quantity: 1, price: 10 });
    expect(emitSnapEvent(build(), emit, store)).toBe(true);
    expect(emitSnapEvent(build(), emit, store)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe("START_CHECKOUT", () => {
  it("reports the cart's own total and its items", () => {
    const event = buildSnapCheckout({
      itemCount: 2,
      total: 128.97,
      items: [{ slug: "bpc-157" }, { slug: "tb-500" }],
    })!;
    expect(event.name).toBe("START_CHECKOUT");
    expect(event.properties.price).toBe(128.97);
    expect(event.properties.number_items).toBe(2);
    expect(event.properties.item_ids).toEqual(["bpc-157", "tb-500"]);
  });

  it("does not fire on an empty or zero-value cart", () => {
    expect(buildSnapCheckout({ itemCount: 0, total: 0 })).toBeNull();
    expect(buildSnapCheckout({ itemCount: 1, total: -5 })).toBeNull();
  });

  it("still reports the checkout when no line is identifiable", () => {
    // The total is authoritative even when the lines are not, and unlike a
    // purchase this is not a conversion Snap will flag for a missing id.
    const event = buildSnapCheckout({ itemCount: 1, total: 20, items: [{ slug: null }] })!;
    expect(event.properties).not.toHaveProperty("item_ids");
    expect(event.properties.price).toBe(20);
  });
});

describe("PURCHASE — must represent real paid revenue", () => {
  const paid = {
    orderId: "ord-123",
    isPaid: true,
    amountPaid: 128.97,
    items: [{ slug: "bpc-157-5mg", productId: "uuid", productName: "BPC-157 5mg", quantity: 3, unitPrice: 42.99 }],
  };

  it("builds from the settled amount and the real line items", () => {
    const event = buildSnapPurchase(paid)!;
    expect(event.name).toBe("PURCHASE");
    expect(event.properties.price).toBe(128.97);
    expect(event.properties.currency).toBe(SNAP_CURRENCY);
    expect(event.properties.item_ids).toEqual(["bpc-157-5mg"]);
    expect(event.properties.number_items).toBe(3);
    expect(event.properties.transaction_id).toBe("ord-123");
  });

  it("cannot fire for an order the backend has not marked paid", () => {
    // Every one of these reaches the confirmation URL in the real system, and
    // every one of them arrives here with isPaid false.
    for (const scenario of ["pending", "failed", "cancelled", "refunded", "awaiting_manual_payment"]) {
      expect(buildSnapPurchase({ ...paid, isPaid: false }), scenario).toBeNull();
    }
  });

  it("cannot fire with no money actually settled", () => {
    expect(buildSnapPurchase({ ...paid, amountPaid: 0 })).toBeNull();
    expect(buildSnapPurchase({ ...paid, amountPaid: -10 })).toBeNull();
  });

  it("refuses an order with no id", () => {
    expect(buildSnapPurchase({ ...paid, orderId: "" })).toBeNull();
  });

  it("still identifies itself when no line resolves, and keeps the revenue", () => {
    const event = buildSnapPurchase({
      ...paid,
      items: [{ productName: "Name Only", quantity: 1, unitPrice: 30 }],
    })!;
    expect(event.properties.item_ids).toEqual(["order-ord-123"]);
    expect(event.properties.item_ids?.[0]).not.toContain("Name Only");
    expect(event.properties.price).toBe(128.97);
  });

  it("reports the conversion even with no line items at all", () => {
    const event = buildSnapPurchase({ ...paid, items: [] })!;
    expect(event.properties.item_ids).toEqual(["order-ord-123"]);
    expect(event.properties.number_items).toBe(1);
  });

  it("fires exactly once per order however many times the page is opened", () => {
    const store = memoryStore();
    const emit = vi.fn();
    expect(emitSnapEvent(buildSnapPurchase(paid), emit, store)).toBe(true);
    // refresh, back button, re-render, forwarded link…
    for (let i = 0; i < 5; i++) expect(emitSnapEvent(buildSnapPurchase(paid), emit, store)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("PURCHASE", expect.objectContaining({ price: 128.97 }));
  });

  it("keeps separate orders separate", () => {
    const store = memoryStore();
    const emit = vi.fn();
    emitSnapEvent(buildSnapPurchase(paid), emit, store);
    emitSnapEvent(buildSnapPurchase({ ...paid, orderId: "ord-456" }), emit, store);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("uses a dedupe key that cannot collide with TikTok's browser store", () => {
    // Both platforms share one localStorage-backed store on the confirmation
    // page. If they shared a key, whichever fired first would silence the other.
    const snap = buildSnapPurchase(paid)!;
    const tiktok = buildPurchase(paid)!;
    expect(snap.dedupeKey).toBe("snap-purchase:ord-123");
    expect(snap.dedupeKey).not.toBe(tiktok.dedupeKey);

    const store = memoryStore();
    const emit = vi.fn();
    expect(emitSnapEvent(snap, emit, store)).toBe(true);
    expect(store.has(tiktok.dedupeKey!)).toBe(false);
  });
});

describe("item_category", () => {
  it("labels a product view with its catalogue category", () => {
    const event = buildSnapViewContent({ slug: "bpc-157", price: 42.99, category: "Research Peptides" })!;
    expect(event.properties.item_category).toBe("Research Peptides");
  });

  it("labels an add to cart from the same catalogue field", () => {
    const event = buildSnapAddToCart({ slug: "bpc-157", quantity: 1, price: 42.99, category: "Research Peptides" })!;
    expect(event.properties.item_category).toBe("Research Peptides");
  });

  it("is omitted rather than guessed when a cart spans categories", () => {
    // Snap takes one category per event. With two, any choice misdescribes the
    // other, and a wrong label is worse for reporting than a missing one.
    const mixed = buildSnapCheckout({
      itemCount: 2,
      total: 90,
      items: [{ slug: "bpc-157", category: "Research Peptides" }, { slug: "bac-water", category: "Supplies" }],
    })!;
    expect(mixed.properties).not.toHaveProperty("item_category");

    const uniform = buildSnapCheckout({
      itemCount: 2,
      total: 90,
      items: [{ slug: "bpc-157", category: "Research Peptides" }, { slug: "tb-500", category: "Research Peptides" }],
    })!;
    expect(uniform.properties.item_category).toBe("Research Peptides");
  });

  it("is omitted entirely when nothing supplies one", () => {
    expect(buildSnapViewContent({ slug: "bpc-157" })!.properties).not.toHaveProperty("item_category");
    expect(buildSnapCheckout({ itemCount: 1, total: 10 })!.properties).not.toHaveProperty("item_category");
    expect(
      buildSnapAddToCart({ slug: "x", quantity: 1, price: 1, category: "   " })!.properties,
    ).not.toHaveProperty("item_category");
  });
});

describe("success and payment_info_available", () => {
  const paid = { orderId: "ord-1", isPaid: true, amountPaid: 50, items: [{ slug: "b12", quantity: 1, unitPrice: 50 }] };

  it("reports success only on an order that actually settled", () => {
    expect(buildSnapPurchase(paid)!.properties.success).toBe(1);
  });

  it("has no way to report a failed purchase, because it never builds one", () => {
    // success: 0 would mean "a purchase happened and failed". Every such order
    // yields a null event instead, so the field is 1 or the event is absent.
    for (const variant of [{ ...paid, isPaid: false }, { ...paid, amountPaid: 0 }]) {
      expect(buildSnapPurchase(variant)).toBeNull();
    }
  });

  it("tells Snap no payment credential is on file at checkout", () => {
    // True of this store by design: the card is entered on the payment
    // provider's hosted page after this event, and nothing is ever saved.
    expect(buildSnapCheckout({ itemCount: 1, total: 20 })!.properties.payment_info_available).toBe(0);
  });
});

describe("identity — hashed or not at all", () => {
  const paid = { orderId: "ord-1", isPaid: true, amountPaid: 50, items: [{ slug: "b12", quantity: 1, unitPrice: 50 }] };
  const digest = "a".repeat(64);
  const phoneDigest = "b".repeat(64);

  it("carries the digests when the server supplies them", () => {
    const event = buildSnapPurchase(paid, { identity: { hashedEmail: digest, hashedPhone: phoneDigest } })!;
    expect(event.properties.user_hashed_email).toBe(digest);
    expect(event.properties.user_hashed_phone_number).toBe(phoneDigest);
  });

  it("drops a raw email address instead of sending it", () => {
    // The exact mistake Snapchat's own template invites: 'user_email':
    // 'INSERT_USER_EMAIL'. Pasted with a real value it leaks a customer
    // address to a third party on every event, silently.
    const event = buildSnapPurchase(paid, { identity: { hashedEmail: "customer@example.com" } })!;
    expect(event.properties).not.toHaveProperty("user_hashed_email");
    expect(JSON.stringify(event.properties)).not.toContain("@");
  });

  it("drops a raw phone number instead of sending it", () => {
    const event = buildSnapPurchase(paid, { identity: { hashedPhone: "+1 (555) 010-9999" } })!;
    expect(event.properties).not.toHaveProperty("user_hashed_phone_number");
  });

  it("sends no identity fields at all when there is nothing to send", () => {
    for (const identity of [undefined, null, {}, { hashedEmail: null, hashedPhone: null }, { hashedEmail: "" }]) {
      const properties = buildSnapPurchase(paid, { identity })!.properties;
      expect(properties).not.toHaveProperty("user_hashed_email");
      expect(properties).not.toHaveProperty("user_hashed_phone_number");
    }
  });

  it("never carries an identity on an event that precedes a paid order", () => {
    // View, add and checkout have no identity parameter at all — there is no
    // argument to pass one through, so no future call site can add one by
    // accident. The customer is known on exactly one page.
    const events = [
      buildSnapViewContent({ slug: "b12", price: 50 })!,
      buildSnapAddToCart({ slug: "b12", quantity: 1, price: 50 })!,
      buildSnapCheckout({ itemCount: 1, total: 50 })!,
    ];
    for (const event of events) {
      expect(Object.keys(event.properties).filter((key) => key.startsWith("user_"))).toEqual([]);
    }
  });

  it("accepts a SHA-256 digest and nothing that merely looks like one", () => {
    expect(hashedOnly(digest)).toBe(digest);
    expect(hashedOnly(digest.toUpperCase())).toBe(digest);
    expect(hashedOnly(`  ${digest}  `)).toBe(digest);
    for (const bad of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "customer@example.com", "", null, undefined]) {
      expect(hashedOnly(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("emitSnapEvent", () => {
  it("sends nothing for a null event", () => {
    const emit = vi.fn();
    expect(emitSnapEvent(null, emit, memoryStore())).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("the two platforms describe the same funnel the same way", () => {
  // Snap and TikTok are reconciled against each other and against the orders
  // table. That only works if one product is one identifier and one action is
  // one key on both — otherwise a discrepancy is indistinguishable from a
  // tracking failure.
  const order = {
    orderId: "VL-EB6E0751",
    isPaid: true,
    amountPaid: 68.49,
    items: [{ slug: "b12", productId: "uuid", productName: "B12", quantity: 1, unitPrice: 49.99 }],
  };

  it("identifies a product with the same id at every step", () => {
    const snapIds = [
      buildSnapViewContent({ slug: "b12", price: 49.99 })!.properties.item_ids,
      buildSnapAddToCart({ slug: "b12", variantId: "dose-10", quantity: 1, price: 49.99 })!.properties.item_ids,
      buildSnapCheckout({ itemCount: 1, total: 68.49, items: [{ slug: "b12" }] })!.properties.item_ids,
      buildSnapPurchase(order)!.properties.item_ids,
    ];
    expect(snapIds).toEqual([["b12"], ["b12"], ["b12"], ["b12"]]);

    const tiktokIds = [
      buildViewContent({ slug: "b12", price: 49.99 }),
      buildAddToCart({ slug: "b12", variantId: "dose-10", quantity: 1, price: 49.99 }),
      buildInitiateCheckout({ itemCount: 1, total: 68.49, items: [{ slug: "b12", quantity: 1, price: 49.99 }] }),
      buildPurchase(order),
    ].map((event) => event!.properties.contents?.map((content) => content.content_id));
    expect(tiktokIds).toEqual(snapIds);
  });

  it("derives the same dedupe id for the same action on both platforms", () => {
    const pairs: [string | undefined, string | undefined][] = [
      [buildSnapViewContent({ slug: "b12", price: 49.99 })?.properties.client_dedup_id, buildViewContent({ slug: "b12", price: 49.99 })?.eventId],
      [
        buildSnapAddToCart({ slug: "b12", variantId: "dose-10", quantity: 1, price: 49.99 })?.properties.client_dedup_id,
        buildAddToCart({ slug: "b12", variantId: "dose-10", quantity: 1, price: 49.99 })?.eventId,
      ],
      [
        buildSnapCheckout({ itemCount: 1, total: 68.49, items: [{ slug: "b12" }] })?.properties.client_dedup_id,
        buildInitiateCheckout({ itemCount: 1, total: 68.49, items: [{ slug: "b12", quantity: 1, price: 49.99 }] })?.eventId,
      ],
      [buildSnapPurchase(order)?.properties.client_dedup_id, buildPurchase(order)?.eventId],
    ];
    for (const [snap, tiktok] of pairs) {
      expect(snap).toBeTruthy();
      expect(snap).toBe(tiktok);
    }
  });

  it("agrees with TikTok about whether a purchase happened at all", () => {
    for (const variant of [
      { ...order, isPaid: false },
      { ...order, amountPaid: 0 },
      { ...order, amountPaid: -1 },
      { ...order, orderId: "" },
      order,
    ]) {
      expect(Boolean(buildSnapPurchase(variant))).toBe(Boolean(buildPurchase(variant)));
    }
  });

  it("agrees with TikTok about the money", () => {
    expect(buildSnapPurchase(order)!.properties.price).toBe(buildPurchase(order)!.properties.value);
  });

  it("never sends a value that is not a rounded number of cents", () => {
    const values = [
      buildSnapViewContent({ slug: "b12", price: 49.994 })?.properties.price,
      buildSnapAddToCart({ slug: "b12", quantity: 3, price: 13.333 })?.properties.price,
      buildSnapCheckout({ itemCount: 1, total: 68.4949 })?.properties.price,
      buildSnapPurchase({ ...order, amountPaid: 68.4949 })?.properties.price,
    ];
    for (const value of values) {
      expect(value).toBeTypeOf("number");
      expect(value).toBe(Math.round(value! * 100) / 100);
    }
  });

  it("gives every event a derived id that survives a repeat", () => {
    const build = () => [
      buildSnapViewContent({ slug: "b12", price: 49.99 })!.properties.client_dedup_id,
      buildSnapAddToCart({ slug: "b12", quantity: 1, price: 49.99 })!.properties.client_dedup_id,
      buildSnapCheckout({ itemCount: 1, total: 68.49 })!.properties.client_dedup_id,
      buildSnapPurchase(order)!.properties.client_dedup_id,
    ];
    const first = build();
    expect(build()).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});
