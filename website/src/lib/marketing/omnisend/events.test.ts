import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_VERSIONS,
  buildCartEvent,
  buildOrderEvent,
  buildViewedProduct,
  sendOmnisendEvent,
  slugify,
  transientOmnisendRefusal,
  type OmnisendLineItem,
  type OmnisendOrder,
  omnisendEventId,
} from "@/lib/marketing/omnisend/events";

// ---------------------------------------------------------------------------
// The property names are the entire risk. Omnisend answers 2xx to an event
// whose property is misspelled and the automation keyed on it never fires,
// so every name from spec §5.2 is pinned here against fixed inputs. The
// builders are pure, which is what makes fixing the inputs possible.
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const AT = Date.parse("2026-09-14T12:34:56.789Z");
const HOUR = "2026-09-14T12:00:00.000Z";

const bpc: OmnisendLineItem = {
  productID: "bpc-157",
  productVariantID: "bpc-157#10mg",
  productTitle: "BPC-157",
  productVariantTitle: "10mg",
  productPrice: 94.99,
  productQuantity: 2,
  productSKU: "VL-BPC-10",
  productImageURL: "https://www.vantalabsresearch.com/images/bpc-157.png",
  productURL: "https://www.vantalabsresearch.com/products/bpc-157",
  productCategories: [{ id: "repair-recovery-research", title: "Repair & Recovery Research" }],
};

const water: OmnisendLineItem = {
  productID: "bacteriostatic-water",
  productTitle: "Bacteriostatic Water",
  productPrice: 12.5,
  productQuantity: 1,
  productURL: "https://www.vantalabsresearch.com/products/bacteriostatic-water",
};

function order(overrides: Partial<OmnisendOrder> = {}): OmnisendOrder {
  return {
    orderId: "order-123",
    orderNumber: "VL-1001",
    orderType: "product",
    replacementOf: null,
    email: "  Jo@Example.COM ",
    customerName: "Jo Ann Smith",
    currency: "usd",
    amountPaid: 198.48,
    subtotal: 202.48,
    shipping: 6,
    discount: 10,
    tax: 0,
    couponCode: "WELCOME10",
    createdAt: "2026-09-14T11:00:00.000Z",
    paidAt: "2026-09-14T11:05:00.000Z",
    shippedAt: "2026-09-15T09:00:00.000Z",
    trackingNumber: "9400111899223456789012",
    carrier: "USPS",
    address: { line1: "1 Main St", line2: "Suite 2", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    lineItems: [bpc, water],
    siteOrigin: "https://www.vantalabsresearch.com",
    ...overrides,
  };
}

describe("EVENT_VERSIONS matches spec §5.2", () => {
  it("versions each system event, and sends the empty string for cart and checkout", () => {
    expect(EVENT_VERSIONS).toEqual({
      "viewed product": "v4",
      "added product to cart": "",
      "started checkout": "",
      "placed order": "v2",
      "paid for order": "v2",
      "order fulfilled": "v2",
      "order canceled": "v2",
      "order refunded": "v2",
    });
  });
});

describe("slugify", () => {
  it("turns a category title into Omnisend's category id", () => {
    expect(slugify("Repair & Recovery Research")).toBe("repair-recovery-research");
  });

  it("trims leading and trailing dashes and collapses runs", () => {
    expect(slugify("  --Metabolic / Longevity--  ")).toBe("metabolic-longevity");
    expect(slugify("")).toBe("");
  });
});

describe("viewed product", () => {
  const event = buildViewedProduct({
    email: "  Jo@Example.COM ",
    product: {
      slug: "bpc-157",
      title: "BPC-157",
      priceCents: 9499,
      url: "https://www.vantalabsresearch.com/products/bpc-157?t=tok",
      imageUrl: "https://www.vantalabsresearch.com/images/bpc-157.png",
      inStock: true,
      category: "Repair & Recovery Research",
    },
    at: AT,
  });

  it("carries the envelope: name, origin api, version v4, eventTime of the view", () => {
    expect(event.eventName).toBe("viewed product");
    expect(event.origin).toBe("api");
    expect(event.eventVersion).toBe("v4");
    expect(event.eventTime).toBe("2026-09-14T12:34:56.789Z");
  });

  it("lowercases and trims the contact email", () => {
    expect(event.contact).toEqual({ email: "jo@example.com" });
  });

  it("pins every product property name, with the price in dollars", () => {
    expect(event.properties).toEqual({
      product: {
        id: "bpc-157",
        title: "BPC-157",
        price: 94.99,
        currency: "USD",
        url: "https://www.vantalabsresearch.com/products/bpc-157?t=tok",
        imageUrl: "https://www.vantalabsresearch.com/images/bpc-157.png",
        status: "inStock",
        categories: [{ id: "repair-recovery-research", title: "Repair & Recovery Research" }],
      },
    });
  });

  it("derives the eventID from email, slug and the hour bucket", () => {
    expect(event.eventID).toBe(omnisendEventId(`jo@example.com:bpc-157:${HOUR}`));
    const later = buildViewedProduct({ ...viewInput(), at: AT + 20 * 60 * 1000 });
    expect(later.eventID).toBe(event.eventID);
    const nextHour = buildViewedProduct({ ...viewInput(), at: AT + 60 * 60 * 1000 });
    expect(nextHour.eventID).toBe(omnisendEventId("jo@example.com:bpc-157:2026-09-14T13:00:00.000Z"));
  });

  it("reports outOfStock, no categories and no imageUrl when it has none", () => {
    const bare = buildViewedProduct({
      email: "jo@example.com",
      product: { slug: "tb-500", title: "TB-500", priceCents: 4200, url: "https://x/tb-500", inStock: false },
      at: AT,
    });
    const product = bare.properties.product as Record<string, unknown>;
    expect(product.status).toBe("outOfStock");
    expect(product.categories).toEqual([]);
    expect(product).not.toHaveProperty("imageUrl");
  });

  function viewInput() {
    return {
      email: "jo@example.com",
      product: { slug: "bpc-157", title: "BPC-157", priceCents: 9499, url: "https://x/bpc-157", inStock: true },
    };
  }
});

describe("cart and checkout", () => {
  const input = {
    email: "  Jo@Example.COM ",
    cartId: "cart-abc",
    lineItems: [bpc, water],
    checkoutUrl: "https://www.vantalabsresearch.com/api/email/omnisend-link?to=%2Fcheckout",
    at: AT,
  };
  const added = buildCartEvent({ name: "added product to cart", ...input });
  const checkout = buildCartEvent({ name: "started checkout", ...input });

  it("carries the envelope with the empty eventVersion present, not absent", () => {
    expect(added.eventName).toBe("added product to cart");
    expect(checkout.eventName).toBe("started checkout");
    for (const event of [added, checkout]) {
      expect(event.origin).toBe("api");
      expect(event).toHaveProperty("eventVersion", "");
      expect(event.eventTime).toBe("2026-09-14T12:34:56.789Z");
      expect(event.contact).toEqual({ email: "jo@example.com" });
    }
  });

  it("pins every cart property name and sums value from price times quantity", () => {
    expect(Object.keys(added.properties).sort()).toEqual(
      ["abandonedCheckoutURL", "addedItem", "cartID", "currency", "lineItems", "value"].sort(),
    );
    expect(added.properties.cartID).toBe("cart-abc");
    expect(added.properties.abandonedCheckoutURL).toBe(input.checkoutUrl);
    expect(added.properties.currency).toBe("USD");
    expect(added.properties.value).toBe(202.48);
  });

  it("pins every line item property name, with unknown optionals omitted", () => {
    const lines = added.properties.lineItems as OmnisendLineItem[];
    expect(lines[0]).toEqual({
      productID: "bpc-157",
      productVariantID: "bpc-157#10mg",
      productTitle: "BPC-157",
      productVariantTitle: "10mg",
      productPrice: 94.99,
      productQuantity: 2,
      productSKU: "VL-BPC-10",
      productImageURL: "https://www.vantalabsresearch.com/images/bpc-157.png",
      productURL: "https://www.vantalabsresearch.com/products/bpc-157",
      productCategories: [{ id: "repair-recovery-research", title: "Repair & Recovery Research" }],
    });
    expect(lines[1]).toEqual({
      productID: "bacteriostatic-water",
      productTitle: "Bacteriostatic Water",
      productPrice: 12.5,
      productQuantity: 1,
      productURL: "https://www.vantalabsresearch.com/products/bacteriostatic-water",
      productCategories: [],
    });
  });

  it("addedItem defaults to the last line for an add, and is absent from a checkout", () => {
    expect(added.properties.addedItem).toEqual((added.properties.lineItems as OmnisendLineItem[])[1]);
    expect(checkout.properties).not.toHaveProperty("addedItem");
    const explicit = buildCartEvent({ name: "added product to cart", ...input, addedItem: bpc });
    expect((explicit.properties.addedItem as OmnisendLineItem).productID).toBe("bpc-157");
  });

  it("derives the eventID from the cart id, the event name and a hash of the contents", () => {
    const contents = sha256(
      JSON.stringify([
        ["bpc-157", "bpc-157#10mg", 2],
        ["bacteriostatic-water", "", 1],
      ]),
    ).slice(0, 12);
    expect(added.eventID).toBe(omnisendEventId(`cart-abc:added product to cart:${contents}`));
    expect(checkout.eventID).toBe(omnisendEventId(`cart-abc:started checkout:${contents}`));
  });

  it("is deterministic: same contents, same id; a quantity change, a new id", () => {
    const again = buildCartEvent({ name: "added product to cart", ...input, at: AT + 5000 });
    expect(again.eventID).toBe(added.eventID);
    const more = buildCartEvent({
      name: "added product to cart",
      ...input,
      lineItems: [{ ...bpc, productQuantity: 3 }, water],
    });
    expect(more.eventID).not.toBe(added.eventID);
    expect(more.properties.value).toBe(297.47);
  });

  it("rounds value to two decimals rather than leaking float noise", () => {
    const event = buildCartEvent({
      name: "started checkout",
      email: "a@b.co",
      cartId: "c",
      lineItems: [{ ...water, productPrice: 0.1, productQuantity: 3 }],
      checkoutUrl: "https://x/checkout",
    });
    expect(event.properties.value).toBe(0.3);
  });
});

describe("order events", () => {
  const placed = buildOrderEvent({ name: "placed order", order: order(), at: AT })!;
  const paid = buildOrderEvent({ name: "paid for order", order: order(), at: AT })!;
  const fulfilled = buildOrderEvent({ name: "order fulfilled", order: order(), at: AT })!;
  const canceled = buildOrderEvent({ name: "order canceled", order: order(), at: AT })!;
  const refunded = buildOrderEvent({ name: "order refunded", order: order(), at: AT })!;
  const all = { placed, paid, fulfilled, canceled, refunded };

  it("builds all five with origin api and version v2", () => {
    for (const event of Object.values(all)) {
      expect(event).not.toBeNull();
      expect(event.origin).toBe("api");
      expect(event.eventVersion).toBe("v2");
    }
    expect(placed.eventName).toBe("placed order");
    expect(paid.eventName).toBe("paid for order");
    expect(fulfilled.eventName).toBe("order fulfilled");
    expect(canceled.eventName).toBe("order canceled");
    expect(refunded.eventName).toBe("order refunded");
  });

  it("derives the eventID from the order id and the event name", () => {
    expect(placed.eventID).toBe(omnisendEventId("order-123:placed order"));
    expect(paid.eventID).toBe(omnisendEventId("order-123:paid for order"));
    expect(fulfilled.eventID).toBe(omnisendEventId("order-123:order fulfilled"));
    expect(canceled.eventID).toBe(omnisendEventId("order-123:order canceled"));
    expect(refunded.eventID).toBe(omnisendEventId("order-123:order refunded"));
    expect(buildOrderEvent({ name: "placed order", order: order(), at: AT + 1 })!.eventID).toBe(placed.eventID);
  });

  it("lowercases the contact email and carries the name, and never a phone", () => {
    expect(placed.contact).toEqual({
      email: "jo@example.com",
      firstName: "Jo",
      lastName: "Ann Smith",
    });
  });

  // THE PHONE IS THE SMS CHANNEL. Omnisend creates or updates the contact
  // from an event's contact block, so a phone there becomes a phone
  // identifier on a contact whose upsert (contact-payload.ts) deliberately
  // sent none, because the customer never ticked the SMS box. The checkout
  // phone is for the courier, not for marketing, and the privacy policy says
  // it reaches Omnisend only with SMS consent; no order event carries it
  // anywhere, contact block or address block.
  it("carries no phone anywhere in any order event", () => {
    for (const event of Object.values(all)) {
      expect(event.contact).not.toHaveProperty("phone");
      expect(event.properties.billingAddress).not.toHaveProperty("phone");
      expect(event.properties.shippingAddress).not.toHaveProperty("phone");
      expect(JSON.stringify(event)).not.toMatch(/phone/i);
    }
  });

  it("the builders and the order loader never read a phone at all", () => {
    const dir = join(process.cwd(), "src/lib/marketing/omnisend");
    const strip = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .map((line) => line.replace(/\s\/\/.*$/, ""))
        .join("\n");
    expect(strip(readFileSync(join(dir, "events.ts"), "utf8"))).not.toMatch(/phone/i);
    expect(strip(readFileSync(join(dir, "orders.ts"), "utf8"))).not.toMatch(/phone/i);
  });

  it("pins every order property name, with prices from the order row", () => {
    expect(Object.keys(placed.properties).sort()).toEqual(
      [
        "orderID",
        "orderNumber",
        "createdAt",
        "currency",
        "subTotalPrice",
        "totalPrice",
        "totalDiscount",
        "totalTax",
        "shippingPrice",
        "paymentStatus",
        "fulfillmentStatus",
        "discounts",
        "lineItems",
        "billingAddress",
        "shippingAddress",
        "orderStatusURL",
      ].sort(),
    );
    expect(placed.properties).toMatchObject({
      orderID: "order-123",
      orderNumber: "VL-1001",
      createdAt: "2026-09-14T11:00:00.000Z",
      currency: "usd",
      subTotalPrice: 202.48,
      totalPrice: 198.48,
      totalDiscount: 10,
      totalTax: 0,
      shippingPrice: 6,
      discounts: [{ code: "WELCOME10" }],
      orderStatusURL: "https://www.vantalabsresearch.com/account/orders",
    });
    const lines = placed.properties.lineItems as OmnisendLineItem[];
    expect(lines.map((line) => line.productID)).toEqual(["bpc-157", "bacteriostatic-water"]);
    expect(lines[0].productPrice).toBe(94.99);
    expect(lines[0].productQuantity).toBe(2);
  });

  it("falls back to the order id as the order number and an empty discounts list", () => {
    const event = buildOrderEvent({ name: "placed order", order: order({ orderNumber: null, couponCode: "  " }) })!;
    expect(event.properties.orderNumber).toBe("order-123");
    expect(event.properties.discounts).toEqual([]);
  });

  it("pins the address property names, sent as both billing and shipping", () => {
    const address = {
      firstName: "Jo",
      lastName: "Ann Smith",
      address1: "1 Main St",
      address2: "Suite 2",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
    };
    expect(placed.properties.billingAddress).toEqual(address);
    expect(placed.properties.shippingAddress).toEqual(address);
  });

  it("omits address fields the order does not carry", () => {
    const event = buildOrderEvent({ name: "placed order", order: order({ address: null, customerName: null }) })!;
    expect(event.properties.shippingAddress).toEqual({});
    expect(event.contact).toEqual({ email: "jo@example.com" });
  });

  it("maps paymentStatus: paid, except canceled and refunded", () => {
    expect(placed.properties.paymentStatus).toBe("paid");
    expect(paid.properties.paymentStatus).toBe("paid");
    expect(fulfilled.properties.paymentStatus).toBe("paid");
    expect(canceled.properties.paymentStatus).toBe("canceled");
    expect(refunded.properties.paymentStatus).toBe("refunded");
  });

  it("maps fulfillmentStatus: unfulfilled, except fulfilled and canceled", () => {
    expect(placed.properties.fulfillmentStatus).toBe("unfulfilled");
    expect(paid.properties.fulfillmentStatus).toBe("unfulfilled");
    expect(refunded.properties.fulfillmentStatus).toBe("unfulfilled");
    expect(fulfilled.properties.fulfillmentStatus).toBe("fulfilled");
    expect(canceled.properties.fulfillmentStatus).toBe("canceled");
  });

  it("carries tracking only on a fulfilment that has a tracking number", () => {
    expect(fulfilled.properties.tracking).toEqual({
      courierTitle: "USPS",
      courierURL: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012",
    });
    for (const event of [placed, paid, canceled, refunded]) expect(event.properties).not.toHaveProperty("tracking");
    const untracked = buildOrderEvent({ name: "order fulfilled", order: order({ trackingNumber: null }) })!;
    expect(untracked.properties).not.toHaveProperty("tracking");
  });

  it("falls back to the order list for an unrecognised carrier, never a 3PL page", () => {
    const event = buildOrderEvent({
      name: "order fulfilled",
      order: order({ carrier: "Some Courier", trackingNumber: "ZZ-1" }),
    })!;
    expect(event.properties.tracking).toEqual({
      courierTitle: "Some Courier",
      courierURL: "https://www.vantalabsresearch.com/account/orders",
    });
  });

  it("carries refundedLineItems only on a refund", () => {
    expect(refunded.properties.refundedLineItems).toEqual(refunded.properties.lineItems);
    for (const event of [placed, paid, fulfilled, canceled]) expect(event.properties).not.toHaveProperty("refundedLineItems");
  });

  it("times placed and paid at the payment, fulfilment at the shipment, and the rest now", () => {
    expect(placed.eventTime).toBe("2026-09-14T11:05:00.000Z");
    expect(paid.eventTime).toBe("2026-09-14T11:05:00.000Z");
    expect(fulfilled.eventTime).toBe("2026-09-15T09:00:00.000Z");
    expect(canceled.eventTime).toBe("2026-09-14T12:34:56.789Z");
    expect(refunded.eventTime).toBe("2026-09-14T12:34:56.789Z");
    const unpaid = buildOrderEvent({ name: "placed order", order: order({ paidAt: null }), at: AT })!;
    expect(unpaid.eventTime).toBe("2026-09-14T11:00:00.000Z");
    const unshipped = buildOrderEvent({ name: "order fulfilled", order: order({ shippedAt: null }), at: AT })!;
    expect(unshipped.eventTime).toBe("2026-09-14T12:34:56.789Z");
  });

  it("yields null for a membership charge, a replacement, or an order with no email", () => {
    expect(buildOrderEvent({ name: "paid for order", order: order({ orderType: "membership" }) })).toBeNull();
    expect(buildOrderEvent({ name: "paid for order", order: order({ orderType: "replacement" }) })).toBeNull();
    expect(buildOrderEvent({ name: "paid for order", order: order({ replacementOf: "order-100" }) })).toBeNull();
    expect(buildOrderEvent({ name: "paid for order", order: order({ email: "  " }) })).toBeNull();
  });

  it("treats an unset order type as a sale", () => {
    expect(buildOrderEvent({ name: "paid for order", order: order({ orderType: null }) })).not.toBeNull();
    expect(buildOrderEvent({ name: "paid for order", order: order({ orderType: undefined }) })).not.toBeNull();
  });
});

describe("transientOmnisendRefusal", () => {
  // The order hooks hand a claim back on a refusal that may not recur, so a
  // later notice or the backstop can retry, and keep it (recorded
  // undelivered) on one that will: a 4xx is the request's own fault.
  it("names status 0 (every transport failure), 429 and the gateway 5xx as transient", () => {
    for (const status of [0, 429, 500, 502, 503, 504]) expect(transientOmnisendRefusal(status), String(status)).toBe(true);
  });

  it("treats every other 4xx, and an unknown status, as permanent", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 501, 505]) expect(transientOmnisendRefusal(status), String(status)).toBe(false);
  });

  it("is never true for a success", () => {
    for (const status of [200, 201, 204]) expect(transientOmnisendRefusal(status), String(status)).toBe(false);
  });
});

describe("sendOmnisendEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches the gated transport, which refuses outside production without a network call and without throwing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendOmnisendEvent(buildViewedProduct({
      email: "jo@example.com",
      product: { slug: "bpc-157", title: "BPC-157", priceCents: 9499, url: "https://x/bpc-157", inStock: true },
      at: AT,
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ads reporting disabled");
    expect(Object.keys(result).sort()).toEqual(["error", "ok", "status"]);
  });
});
