import { describe, expect, it } from "vitest";

import {
  buildCartEvent,
  buildOrderEvent,
  buildViewedProduct,
  omnisendEventId,
  type OmnisendOrder,
} from "@/lib/marketing/omnisend/events";

// ---------------------------------------------------------------------------
// AN EVENT ID OMNISEND WILL ACCEPT.
//
// Omnisend requires `eventID` to be a UUID. Every builder here derived a
// descriptive string instead — `${orderId}:${eventName}`, the cart id plus a
// content hash, `${email}:${slug}:${hour}` — so every event this system has
// ever built was refused with
//
//     400  EventID: failed on the 'uuid' tag
//
// Confirmed against the live API on 2026-09-17: nine order events posted, nine
// 400s, every one on that field. It never looked broken because nothing ever
// arrived — an account with no events has nothing visibly wrong with it, and
// the send path treats a 4xx as permanent and records it in the ledger rather
// than raising.
//
// The suite could not catch it either: events.test.ts asserted the exact seed
// strings, so it agreed with the bug in the same way the catalogue tests agreed
// with the "#" separator. This file tests the RULE — the shape Omnisend
// validates — for every builder, so a new event kind cannot reintroduce it.
// ---------------------------------------------------------------------------

/** RFC 4122, as Omnisend's `uuid` tag reads it: version 5, variant 10x. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ORDER: OmnisendOrder = {
  orderId: "order-002eca76-4887-4a0b-8043-e944210ec067",
  email: "buyer@example.com",
  currency: "USD",
  amountPaid: 110.38,
  subtotal: 89.98,
  shipping: 15,
  discount: 0,
  tax: 0,
  createdAt: "2026-09-17T11:47:26.000Z",
  paidAt: "2026-09-17T11:48:51.000Z",
  lineItems: [],
  siteOrigin: "https://www.vantalabsresearch.com",
};

describe("every event id is a uuid", () => {
  it("an order event", () => {
    const event = buildOrderEvent({ name: "paid for order", order: ORDER });
    expect(event?.eventID).toMatch(UUID);
  });

  it("every order event name, not just the one that was tested", () => {
    for (const name of ["placed order", "paid for order", "order fulfilled", "order canceled", "order refunded"] as const) {
      const event = buildOrderEvent({ name, order: ORDER });
      expect(event?.eventID, `${name} must carry a uuid`).toMatch(UUID);
    }
  });

  it("a cart event", () => {
    const event = buildCartEvent({
      name: "added product to cart",
      email: "buyer@example.com",
      cartId: "cart-123",
      checkoutUrl: "https://www.vantalabsresearch.com/checkout",
      currency: "USD",
      lineItems: [],
    });
    expect(event?.eventID).toMatch(UUID);
  });

  it("a product view", () => {
    const event = buildViewedProduct({
      email: "buyer@example.com",
      product: {
        slug: "tesamorelin",
        title: "Tesamorelin",
        priceCents: 7499,
        url: "https://www.vantalabsresearch.com/products/tesamorelin",
        inStock: true,
      },
      at: Date.UTC(2026, 8, 17, 11, 0, 0),
    });
    expect(event?.eventID).toMatch(UUID);
  });
});

describe("the id is still derived, not random", () => {
  // THE PROPERTY THE DESCRIPTIVE STRINGS EXISTED FOR. Omnisend deduplicates on
  // (eventID, eventTime) and the ledger claims a send by eventID, so the same
  // action has to produce the same id every time it is built — across
  // processes, across deploys, for ever. A random uuid would satisfy the
  // format and silently break both.
  it("the same seed always gives the same uuid", () => {
    expect(omnisendEventId("order-1:paid for order")).toBe(omnisendEventId("order-1:paid for order"));
  });

  it("different seeds give different uuids", () => {
    expect(omnisendEventId("order-1:paid for order")).not.toBe(omnisendEventId("order-1:placed order"));
    expect(omnisendEventId("order-1:paid for order")).not.toBe(omnisendEventId("order-2:paid for order"));
  });

  it("rebuilding the same order event twice gives the same id", () => {
    const a = buildOrderEvent({ name: "paid for order", order: ORDER });
    const b = buildOrderEvent({ name: "paid for order", order: { ...ORDER } });
    expect(a?.eventID).toBe(b?.eventID);
  });

  it("is pinned to a literal, so the namespace cannot be changed by accident", () => {
    // Changing OMNISEND_EVENT_NAMESPACE re-ids every event ever sent and
    // breaks dedup on both sides. This value is the guard against that.
    expect(omnisendEventId("order-1:paid for order")).toBe("110041ca-c2de-5650-bfbc-2b6dd91d731f");
  });
});
