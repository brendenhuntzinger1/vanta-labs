import { describe, expect, it } from "vitest";
import { decideRelay, isRelayableEvent, totalIsPlausible, type CatalogEntry } from "./funnel-relay";

const catalog = new Map<string, CatalogEntry>([
  ["b12", { slug: "b12", name: "B12", price: 49.99 }],
  ["bpc-157", { slug: "bpc-157", name: "BPC-157", price: 42.99 }],
]);

describe("what may be relayed at all", () => {
  it("accepts the three browsing events", () => {
    for (const event of ["ViewContent", "AddToCart", "InitiateCheckout"]) {
      expect(isRelayableEvent(event)).toBe(true);
    }
  });

  it("refuses Purchase from the browser", () => {
    // Purchase is the one event that asserts revenue. It comes from the order's
    // own settled payment state or it does not come at all — a public endpoint
    // that accepted it would be a way to write fake sales into ad reporting.
    expect(isRelayableEvent("Purchase")).toBe(false);
    expect(decideRelay({ event: "Purchase", eventId: "p-1", lines: [{ slug: "b12" }] }, catalog)).toMatchObject({
      ok: false,
    });
  });

  it("refuses anything without an event id", () => {
    // Without a shared id the server leg would not deduplicate against the
    // browser leg, and every event would be counted twice.
    expect(decideRelay({ event: "ViewContent", eventId: "  ", lines: [{ slug: "b12" }] }, catalog)).toMatchObject({
      ok: false,
    });
  });
});

describe("the catalogue is the price authority", () => {
  it("prices from the catalogue, ignoring whatever the page claimed", () => {
    const decision = decideRelay({ event: "ViewContent", eventId: "vc-b12", lines: [{ slug: "b12" }] }, catalog);
    expect(decision.ok && decision.contents[0].price).toBe(49.99);
    expect(decision.ok && decision.value).toBe(49.99);
  });

  it("multiplies by a sane quantity", () => {
    const decision = decideRelay({ event: "AddToCart", eventId: "atc-b12", lines: [{ slug: "b12", quantity: 3 }] }, catalog);
    expect(decision.ok && decision.value).toBe(149.97);
  });

  it("clamps an absurd quantity instead of reporting it", () => {
    const decision = decideRelay({ event: "AddToCart", eventId: "a", lines: [{ slug: "b12", quantity: 999999 }] }, catalog);
    expect(decision.ok && decision.contents[0].quantity).toBe(100);
  });

  it("drops a product the catalogue does not know", () => {
    // An unrecognised content id teaches the ad platform about a product that
    // does not exist, and is the shape an injected value would take.
    const decision = decideRelay(
      { event: "InitiateCheckout", eventId: "ic-1", lines: [{ slug: "b12" }, { slug: "not-a-product" }], claimedTotal: 60 },
      catalog,
    );
    expect(decision.ok && decision.contents).toHaveLength(1);
  });

  it("reports nothing when no line is recognised", () => {
    expect(decideRelay({ event: "ViewContent", eventId: "x", lines: [{ slug: "nope" }] }, catalog)).toMatchObject({
      ok: false,
    });
  });
});

describe("a claimed checkout total is validated, not trusted", () => {
  it("accepts a real total that includes shipping and tax", () => {
    // The live case: $49.99 of goods, $15 shipping, $3.50 tax = $68.49.
    const decision = decideRelay(
      { event: "InitiateCheckout", eventId: "ic-1-68.49", lines: [{ slug: "b12" }], claimedTotal: 68.49 },
      catalog,
    );
    expect(decision.ok && decision.value).toBe(68.49);
    expect(decision.ok && decision.totalOverridden).toBe(false);
  });

  it("rejects an inflated total and falls back to the subtotal it computed", () => {
    const decision = decideRelay(
      { event: "InitiateCheckout", eventId: "ic", lines: [{ slug: "b12" }], claimedTotal: 100000 },
      catalog,
    );
    expect(decision.ok && decision.value).toBe(49.99);
    expect(decision.ok && decision.totalOverridden).toBe(true);
  });

  it("rejects a total below the merchandise it names", () => {
    const decision = decideRelay(
      { event: "InitiateCheckout", eventId: "ic", lines: [{ slug: "b12" }], claimedTotal: 1 },
      catalog,
    );
    expect(decision.ok && decision.totalOverridden).toBe(true);
  });

  it("ignores a claimed total on events that do not have one", () => {
    const decision = decideRelay(
      { event: "ViewContent", eventId: "vc", lines: [{ slug: "b12" }], claimedTotal: 99999 },
      catalog,
    );
    expect(decision.ok && decision.value).toBe(49.99);
  });

  it("bands the plausible range around the subtotal", () => {
    expect(totalIsPlausible(49.99, 49.99)).toBe(true);
    expect(totalIsPlausible(68.49, 49.99)).toBe(true);
    expect(totalIsPlausible(49.98, 49.99)).toBe(true); // a cent of rounding
    expect(totalIsPlausible(40, 49.99)).toBe(false);
    expect(totalIsPlausible(200, 49.99)).toBe(false);
    expect(totalIsPlausible(Number.NaN, 49.99)).toBe(false);
    expect(totalIsPlausible(-10, 49.99)).toBe(false);
  });
});

describe("the relayed event matches the browser event", () => {
  it("keeps the id and the content id identical, so TikTok counts one", () => {
    const decision = decideRelay(
      { event: "AddToCart", eventId: "atc-bpc-157::dose-10mg", lines: [{ slug: "bpc-157", quantity: 2 }] },
      catalog,
    );
    expect(decision.ok && decision.eventId).toBe("atc-bpc-157::dose-10mg");
    expect(decision.ok && decision.contents[0].content_id).toBe("bpc-157");
    expect(decision.ok && decision.contents[0].content_type).toBe("product");
  });
});
