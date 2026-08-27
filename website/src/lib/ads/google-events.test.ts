import { describe, expect, it } from "vitest";
import {
  buildGoogleAddToCart,
  buildGoogleBeginCheckout,
  buildGooglePurchase,
  buildGoogleViewItem,
  emitGoogleEvent,
  hashedOnly,
} from "./google-events";
import type { PaidOrder } from "./tiktok-events";

const paidOrder: PaidOrder = {
  orderId: "VL-1001",
  isPaid: true,
  amountPaid: 149.99,
  items: [
    { slug: "bpc-157", productId: "prod_1", productName: "BPC-157", quantity: 2, unitPrice: 59.995 },
    { slug: "tb-500", productId: "prod_2", productName: "TB-500", quantity: 1, unitPrice: 30 },
  ],
};

describe("buildGooglePurchase — the paid gate", () => {
  it("reports a paid order", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.name).toBe("purchase");
    expect(event?.params.value).toBe(149.99);
    expect(event?.params.currency).toBe("USD");
    expect(event?.params.transaction_id).toBe("VL-1001");
  });

  it("returns null for an unpaid order, however complete it looks", () => {
    expect(buildGooglePurchase({ ...paidOrder, isPaid: false })).toBeNull();
  });

  it("returns null for a zero-value order — a fully-discounted sale is not revenue to learn from", () => {
    expect(buildGooglePurchase({ ...paidOrder, amountPaid: 0 })).toBeNull();
  });

  it("returns null for a negative amount", () => {
    expect(buildGooglePurchase({ ...paidOrder, amountPaid: -10 })).toBeNull();
  });

  it("returns null without an order id, since there would be nothing to deduplicate on", () => {
    expect(buildGooglePurchase({ ...paidOrder, orderId: "" })).toBeNull();
  });
});

describe("buildGooglePurchase — the money", () => {
  it("reports the settled total, never a recomputed sum of the lines", () => {
    // The lines sum to 149.99 here, but the settled figure is authoritative
    // even when they disagree — shipping, tax and discounts live in it.
    const event = buildGooglePurchase({ ...paidOrder, amountPaid: 131.5 });
    expect(event?.params.value).toBe(131.5);
  });

  it("rounds to two decimal places rather than emitting float noise", () => {
    const event = buildGooglePurchase({ ...paidOrder, amountPaid: 10.005 });
    expect(event?.params.value).toBe(10.01);
  });

  it("does not send shipping or tax, which the order shape does not carry", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.params).not.toHaveProperty("shipping");
    expect(event?.params).not.toHaveProperty("tax");
  });
});

describe("buildGooglePurchase — product identity", () => {
  it("identifies products by catalogue slug, matching every other channel", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.params.items?.map((item) => item.item_id)).toEqual(["bpc-157", "tb-500"]);
  });

  it("falls back to the product id when a slug is missing", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: "prod_9", productName: "Unslugged", quantity: 1, unitPrice: 10 }],
    });
    expect(event?.params.items?.[0].item_id).toBe("prod_9");
  });

  it("never uses a product name as an identifier", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: null, productName: "BPC-157", quantity: 1, unitPrice: 10 }],
    });
    expect(JSON.stringify(event?.params.items)).not.toContain("BPC-157");
  });

  it("identifies the order itself when no line resolves, rather than reporting nothing", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: null, productName: "Mystery", quantity: 1, unitPrice: 10 }],
    });
    expect(event?.params.items).toEqual([
      { item_id: "order-VL-1001", item_name: "Order (line items unresolved)", quantity: 1, price: 149.99 },
    ]);
  });

  it("floors a fractional quantity to at least one", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: "bpc-157", productId: "p", productName: "n", quantity: 0, unitPrice: 10 }],
    });
    expect(event?.params.items?.[0].quantity).toBe(1);
  });
});

describe("buildGooglePurchase — deduplication identity", () => {
  it("derives transaction_id from the order, never randomly", () => {
    const a = buildGooglePurchase(paidOrder);
    const b = buildGooglePurchase(paidOrder);
    expect(a?.params.transaction_id).toBe(b?.params.transaction_id);
    expect(a?.params.transaction_id).toBe("VL-1001");
  });

  it("carries a dedupe key scoped to google and the order", () => {
    expect(buildGooglePurchase(paidOrder)?.dedupeKey).toBe("google-purchase:VL-1001");
  });
});

describe("hashedOnly", () => {
  it("accepts a SHA-256 digest", () => {
    const digest = "a".repeat(64);
    expect(hashedOnly(digest)).toBe(digest);
  });

  it("drops a raw email address rather than forwarding it", () => {
    expect(hashedOnly("person@example.com")).toBeUndefined();
  });

  it("drops Google's own placeholder text", () => {
    expect(hashedOnly("INSERT_USER_EMAIL")).toBeUndefined();
  });

  it("drops a digest of the wrong length", () => {
    expect(hashedOnly("abc123")).toBeUndefined();
  });
});

describe("buildGooglePurchase — identity", () => {
  it("attaches hashed identity when given it", () => {
    const digest = "b".repeat(64);
    const event = buildGooglePurchase(paidOrder, { identity: { hashedEmail: digest } });
    expect(event?.userData?.sha256_email_address).toBe(digest);
  });

  it("cannot be made to send a raw address", () => {
    const event = buildGooglePurchase(paidOrder, {
      identity: { hashedEmail: "person@example.com" as string },
    });
    expect(JSON.stringify(event)).not.toContain("person@example.com");
    expect(event?.userData).toBeUndefined();
  });
});

describe("the upper funnel", () => {
  it("builds view_item from a catalogue slug", () => {
    const event = buildGoogleViewItem({ slug: "bpc-157", price: 59.99 });
    expect(event?.name).toBe("view_item");
    expect(event?.params.items?.[0].item_id).toBe("bpc-157");
    expect(event?.params.value).toBe(59.99);
  });

  it("refuses to build view_item without a slug", () => {
    expect(buildGoogleViewItem({ slug: "" })).toBeNull();
  });

  it("builds add_to_cart with quantity and value", () => {
    const event = buildGoogleAddToCart({ slug: "bpc-157", price: 59.99, quantity: 2 });
    expect(event?.name).toBe("add_to_cart");
    expect(event?.params.value).toBe(119.98);
    expect(event?.params.items?.[0].quantity).toBe(2);
  });

  it("builds begin_checkout from the cart total", () => {
    const event = buildGoogleBeginCheckout({
      value: 149.99,
      items: [{ slug: "bpc-157", quantity: 2, price: 59.995 }],
    });
    expect(event?.name).toBe("begin_checkout");
    expect(event?.params.value).toBe(149.99);
  });

  it("refuses to build begin_checkout for an empty cart", () => {
    expect(buildGoogleBeginCheckout({ value: 0, items: [] })).toBeNull();
  });
});

describe("emitGoogleEvent", () => {
  it("emits once and honours the dedupe key", () => {
    const seen = new Set<string>();
    const store = { has: (k: string) => seen.has(k), mark: (k: string) => void seen.add(k) };
    const calls: string[] = [];
    const emit = (name: string) => void calls.push(name);

    const event = buildGooglePurchase(paidOrder);
    expect(emitGoogleEvent(event, emit, store)).toBe(true);
    expect(emitGoogleEvent(event, emit, store)).toBe(false);
    expect(calls).toEqual(["purchase"]);
  });

  it("emits nothing for a null event", () => {
    const store = { has: () => false, mark: () => {} };
    expect(emitGoogleEvent(null, () => {}, store)).toBe(false);
  });
});

describe("mutation controls — these must fail if the guard is deleted", () => {
  it("the isPaid check is load-bearing: an unpaid order with every other field valid reports nothing", () => {
    const unpaid: PaidOrder = { ...paidOrder, isPaid: false };
    expect(buildGooglePurchase(unpaid)).toBeNull();
    // Deleting `if (!order.isPaid) return null;` makes this line fail.
  });

  it("transaction_id is derived, not generated: two builds of one order agree", () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => buildGooglePurchase(paidOrder)?.params.transaction_id),
    );
    expect(ids.size).toBe(1);
    // Replacing transaction_id with a uuid or timestamp makes this line fail.
  });

  it("hashedOnly is load-bearing: identity that is not a digest produces no userData", () => {
    const event = buildGooglePurchase(paidOrder, {
      identity: { hashedEmail: "person@example.com", hashedPhone: "+15550101234" },
    });
    expect(event?.userData).toBeUndefined();
    // Removing the hashedOnly filter makes this line fail.
  });
});
