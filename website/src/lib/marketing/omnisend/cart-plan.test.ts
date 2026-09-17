import { describe, expect, it } from "vitest";
import {
  CART_EVENT_DEBOUNCE_MS,
  CART_OFFER_MAX_AGE_MS,
  CART_OFFER_MIN_AGE_MS,
  PRODUCT_VIEW_DEBOUNCE_MS,
  cartLastActivityAt,
  cartOfferQualifies,
  describeRecoveryGift,
  giftDisplayName,
  priceCartLines,
  priceToCents,
  type CartOfferCartRow,
} from "@/lib/marketing/omnisend/cart-plan";
import type { Product } from "@/lib/catalog-types";

// ---------------------------------------------------------------------------
// The decisions the cart hooks and the offer sweep make, pinned without a
// database. Which cart qualifies for Omnisend's 72-hour incentive, what its
// lines are priced at (the catalogue, never the browser), and how a gift is
// described to a customer, are all pure functions of their inputs.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function cart(overrides: Partial<CartOfferCartRow> = {}): CartOfferCartRow {
  return {
    id: "cart-1",
    email: "shopper@example.com",
    status: "active",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1, unitPrice: 42.99 }],
    cart_value_cents: 4299,
    first_seen_at: new Date(NOW - 50 * HOUR_MS).toISOString(),
    last_updated_at: new Date(NOW - 48 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

describe("the windows", () => {
  it("are the ones the brief names: 10 minutes per cart event, 6 hours per product view, 36 to 96 hours for the offer", () => {
    expect(CART_EVENT_DEBOUNCE_MS).toBe(10 * 60 * 1000);
    expect(PRODUCT_VIEW_DEBOUNCE_MS).toBe(6 * HOUR_MS);
    expect(CART_OFFER_MIN_AGE_MS).toBe(36 * HOUR_MS);
    expect(CART_OFFER_MAX_AGE_MS).toBe(96 * HOUR_MS);
  });
});

describe("cartLastActivityAt", () => {
  it("uses the last update, falling back to first sight, and never goes backwards", () => {
    expect(cartLastActivityAt(cart())).toBe(NOW - 48 * HOUR_MS);
    expect(cartLastActivityAt(cart({ last_updated_at: null }))).toBe(NOW - 50 * HOUR_MS);
    expect(cartLastActivityAt(cart({ last_updated_at: undefined }))).toBe(NOW - 50 * HOUR_MS);
    // A last_updated_at older than first_seen_at (a repaired row) reads as first sight.
    expect(cartLastActivityAt(cart({ last_updated_at: new Date(NOW - 60 * HOUR_MS).toISOString() }))).toBe(NOW - 50 * HOUR_MS);
  });
});

describe("cartOfferQualifies", () => {
  const base = { now: NOW, inHouseStages: 0, paidOrders: [] as Array<{ at: number }> };

  it("accepts an open, non-empty cart with an email, no in-house stage and no purchase since, between 36 and 96 hours old", () => {
    expect(cartOfferQualifies({ ...base, row: cart() })).toEqual({ qualifies: true });
    expect(cartOfferQualifies({ ...base, row: cart({ status: "held" }) })).toEqual({ qualifies: true });
  });

  it("refuses a cart younger than 36 hours: Omnisend's own flow is still mid-sequence", () => {
    const young = cart({ last_updated_at: new Date(NOW - 35 * HOUR_MS).toISOString() });
    expect(cartOfferQualifies({ ...base, row: young })).toEqual({ qualifies: false, reason: "too young" });
    // Exactly 36 hours qualifies.
    const edge = cart({ last_updated_at: new Date(NOW - 36 * HOUR_MS).toISOString() });
    expect(cartOfferQualifies({ ...base, row: edge })).toEqual({ qualifies: true });
  });

  it("refuses a cart older than 96 hours as stale", () => {
    const stale = cart({ first_seen_at: new Date(NOW - 120 * HOUR_MS).toISOString(), last_updated_at: new Date(NOW - 97 * HOUR_MS).toISOString() });
    expect(cartOfferQualifies({ ...base, row: stale })).toEqual({ qualifies: false, reason: "stale" });
  });

  it("measures age from the last activity, so a cart edited on day two is still eligible", () => {
    const edited = cart({ first_seen_at: new Date(NOW - 120 * HOUR_MS).toISOString(), last_updated_at: new Date(NOW - 40 * HOUR_MS).toISOString() });
    expect(cartOfferQualifies({ ...base, row: edited })).toEqual({ qualifies: true });
  });

  it("refuses a cart that has received any in-house stage: one owner per cart", () => {
    expect(cartOfferQualifies({ ...base, row: cart(), inHouseStages: 1 })).toEqual({ qualifies: false, reason: "in-house owned" });
  });

  it("refuses a cart whose address paid for a product order since the cart was first seen", () => {
    const paidAfter = [{ at: NOW - 10 * HOUR_MS }];
    expect(cartOfferQualifies({ ...base, row: cart(), paidOrders: paidAfter })).toEqual({ qualifies: false, reason: "bought since" });
    // An order from before the cart is an earlier purchase, not a recovery.
    const paidBefore = [{ at: NOW - 80 * HOUR_MS }];
    expect(cartOfferQualifies({ ...base, row: cart(), paidOrders: paidBefore })).toEqual({ qualifies: true });
  });

  it("refuses a closed cart, an empty cart and a cart with no address", () => {
    expect(cartOfferQualifies({ ...base, row: cart({ status: "recovered" }) })).toEqual({ qualifies: false, reason: "not open" });
    expect(cartOfferQualifies({ ...base, row: cart({ status: "cleared" }) })).toEqual({ qualifies: false, reason: "not open" });
    expect(cartOfferQualifies({ ...base, row: cart({ items: [] }) })).toEqual({ qualifies: false, reason: "no items" });
    expect(cartOfferQualifies({ ...base, row: cart({ items: "junk" }) })).toEqual({ qualifies: false, reason: "no items" });
    expect(cartOfferQualifies({ ...base, row: cart({ email: "  " }) })).toEqual({ qualifies: false, reason: "no email" });
    expect(cartOfferQualifies({ ...base, row: cart({ email: null }) })).toEqual({ qualifies: false, reason: "no email" });
  });
});

describe("giftDisplayName", () => {
  it("uses the catalogue name, except that every Recon Water SKU is called Recon Water", () => {
    expect(giftDisplayName("ghk-cu", "GHK-Cu 50mg")).toBe("GHK-Cu 50mg");
    expect(giftDisplayName("recon-water", "Recon water")).toBe("Recon Water");
    expect(giftDisplayName("bac-water", "BAC Water")).toBe("Recon Water");
    expect(giftDisplayName("bacteriostatic-water", "Bacteriostatic Water 30ml")).toBe("Recon Water");
    // A slug the catalogue cannot name is shown as itself rather than withheld.
    expect(giftDisplayName("klow", undefined)).toBe("klow");
  });
});

describe("describeRecoveryGift", () => {
  const names = new Map([["ghk-cu", "GHK-Cu 50mg"], ["recon-water", "Recon water"], ["klow", "KLOW"]]);

  it("reads as a sentence fragment naming each product with its own article", () => {
    expect(describeRecoveryGift([{ slug: "ghk-cu", quantity: 1 }, { slug: "recon-water", quantity: 1 }], names))
      .toBe("a free GHK-Cu 50mg and a free Recon Water");
    expect(describeRecoveryGift([{ slug: "ghk-cu", quantity: 1 }], names)).toBe("a free GHK-Cu 50mg");
    expect(describeRecoveryGift(
      [{ slug: "klow", quantity: 1 }, { slug: "ghk-cu", quantity: 1 }, { slug: "recon-water", quantity: 1 }],
      names,
    )).toBe("a free KLOW, a free GHK-Cu 50mg and a free Recon Water");
  });

  it("counts a quantity above one, and is empty for no gift", () => {
    expect(describeRecoveryGift([{ slug: "recon-water", quantity: 2 }], names)).toBe("2 free Recon Water");
    expect(describeRecoveryGift([], names)).toBe("");
  });

  it("never says BAC Water, whatever the catalogue row is called", () => {
    const legacy = new Map([["bac-water", "BAC Water 30ml"]]);
    const text = describeRecoveryGift([{ slug: "bac-water", quantity: 1 }], legacy);
    expect(text).toBe("a free Recon Water");
    expect(text).not.toMatch(/bac water/i);
  });

  it("contains no emoji and no exclamation mark", () => {
    const text = describeRecoveryGift([{ slug: "ghk-cu", quantity: 1 }, { slug: "recon-water", quantity: 1 }], names);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("priceToCents", () => {
  it("reads the catalogue's formatted price strings", () => {
    expect(priceToCents("$42.99")).toBe(4299);
    expect(priceToCents("169.99")).toBe(16999);
    expect(priceToCents("$1,249.50")).toBe(124950);
    expect(priceToCents("")).toBe(0);
    expect(priceToCents(undefined)).toBe(0);
    expect(priceToCents("free")).toBe(0);
  });
});

describe("priceCartLines", () => {
  const products = [
    {
      slug: "glp-3",
      name: "GLP-3",
      category: "GLP Research",
      price: "$49.99",
      image: "/images/glp-3.png",
      stockStatus: "In Stock",
      doses: [
        { id: "glp-3-5mg", label: "5mg", price: "$49.99", isDefault: true },
        { id: "glp-3-10mg", label: "10mg", price: "$169.99", salePrice: "$149.99" },
      ],
    },
    { slug: "bpc-157", name: "BPC-157", category: "Repair & Recovery Research", price: "$42.99", salePrice: "$39.99", image: "https://cdn.example/bpc.png", stockStatus: "Limited" },
  ] as unknown as Product[];

  it("prices every line from the catalogue and never from the stored snapshot", () => {
    const lines = priceCartLines(
      [
        { slug: "glp-3", variantId: "glp-3-10mg", name: "hacked name", quantity: 2, unitPrice: 1 },
        { slug: "bpc-157", name: "BPC-157", quantity: 1, unitPrice: 999 },
      ],
      products,
    );
    expect(lines).toEqual([
      { slug: "glp-3", variantId: "glp-3-10mg", title: "GLP-3", variantTitle: "10mg", priceCents: 14999, quantity: 2, image: "/images/glp-3.png", category: "GLP Research" },
      { slug: "bpc-157", variantId: undefined, title: "BPC-157", variantTitle: undefined, priceCents: 3999, quantity: 1, image: "https://cdn.example/bpc.png", category: "Repair & Recovery Research" },
    ]);
  });

  it("drops a line whose slug is not a live product, and one with no usable quantity", () => {
    const lines = priceCartLines(
      [
        { slug: "not-a-product", name: "FREE MONEY", quantity: 1, unitPrice: 1 },
        { slug: "bpc-157", name: "BPC-157", quantity: 0, unitPrice: 42.99 },
        { slug: "bpc-157", name: "BPC-157", quantity: 3, unitPrice: 42.99 },
      ],
      products,
    );
    expect(lines.map((line) => [line.slug, line.quantity])).toEqual([["bpc-157", 3]]);
  });

  it("falls back to the product price when the named dose is unknown, and caps the quantity", () => {
    const lines = priceCartLines([{ slug: "glp-3", variantId: "glp-3-99mg", name: "GLP-3", quantity: 500, unitPrice: 1 }], products);
    expect(lines).toEqual([
      { slug: "glp-3", variantId: "glp-3-99mg", title: "GLP-3", variantTitle: undefined, priceCents: 4999, quantity: 99, image: "/images/glp-3.png", category: "GLP Research" },
    ]);
  });
});
