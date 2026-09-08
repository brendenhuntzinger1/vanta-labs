import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CartItemInput } from "@/lib/payment-types";

// ---------------------------------------------------------------------------
// THE CUSTOMER'S BROWSER IS NOT ALLOWED AN OPINION ABOUT MONEY.
//
// Everything a shopper sees in the cart — line price, dose, bundle rate,
// promotion, gift, total — is computed client-side so the page can be fast.
// None of it may reach the charge. The protection is not a validation step that
// could be forgotten on one route; it is the SHAPE OF THE REQUEST: the checkout
// accepts an id and a count, and nothing else about a line exists to send.
//
// That is worth pinning explicitly, because it is invisible. Nobody reviewing a
// diff sees the absence of a `price` field, and adding one to CartItemInput to
// "avoid a lookup" would compile, pass every existing test, and hand the
// customer the pen.
//
// These assertions read the source rather than executing quoteOrder, which
// reaches Supabase, the catalogue and the profit engine on every call — the
// same convention as quote-order-preview-mode.test.ts, and for the same reason.
// The dollars-on-screen proof is scripts/qa-offer-checkout-journey.mjs.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\/\/.*$/gm, " ");

const TYPES = read("src/lib/payment-types.ts");
const QUOTE = withoutComments(read("src/lib/quote-order.ts"));
const CREATE_SESSION = withoutComments(read("src/app/api/checkout/create-session/route.ts"));

describe("what a cart line is allowed to say", () => {
  // The type, exactly. Written as an equality rather than "does not contain
  // price", because the failure to catch is a NEW field nobody thought of.
  it("is an id and a quantity, and nothing else", () => {
    const declaration = TYPES.match(/export interface CartItemInput \{([\s\S]*?)\n\}/);
    expect(declaration, "CartItemInput must still be declared here").not.toBeNull();
    const fields = (declaration?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .map((line) => line.split(/[?:]/)[0].trim());
    expect(fields.sort()).toEqual(["id", "quantity"]);
  });

  // A compile-time echo of the same thing: these keys must not exist to assign.
  it("has no field a shopper could put a number in", () => {
    const line: CartItemInput = { id: "ghk-cu", quantity: 1 };
    for (const forbidden of ["price", "unitPrice", "priceCents", "unitPriceCents", "lineTotal",
      "cost", "productCostCents", "discount", "percentOff", "free", "isGift", "giftValue", "name", "dose"]) {
      expect(Object.hasOwn(line, forbidden)).toBe(false);
    }
  });
});

describe("where a price actually comes from", () => {
  it("the quote rebuilds every line from the catalogue, keyed only by slug", () => {
    // productsById is built from getCatalogProductsBySlugs — the server's own
    // read — and the line's name, price and stock status are taken from it.
    expect(QUOTE).toContain("const productsById = new Map<string, ServerProduct>(");
    expect(QUOTE).toContain("catalogProducts.map((product) => [");
    expect(QUOTE).toContain("price: parseProductPrice(product.price),");
  });

  it("a slug the catalogue does not return is refused, never priced at anything", () => {
    expect(QUOTE).toContain("throw new Error(`Invalid product id: ${item.id}`)");
  });

  // The client sends "slug::doseId". The DOSE is resolved server-side from that
  // id, so a shopper cannot pair an expensive dose's id with a cheap dose's
  // price — there is no price in the request to pair it with.
  it("resolves the dose from the id rather than trusting a claimed dose", () => {
    expect(QUOTE).toContain("const [slug, variantId] = item.id.split(\"::\")");
  });

  it("sanitises the id and the quantity before anything is looked up", () => {
    expect(QUOTE).toContain("id: sanitizeText(item.id),");
  });
});

describe("the one way an order acquires a $0 line", () => {
  // A free unit exists only where the server put it: behind a token it looked
  // up itself in customer_offers. The client's copy of the offer is a cookie it
  // cannot read, and the reservation re-checks the binding under a row lock —
  // see sql/customer-offers.sql and its 48 real-Postgres abuse tests.
  it("is a server-resolved offer token, not anything the client claims", () => {
    // The row is fetched by token AND address together, so the reward the quote
    // prices is the one that address owns. A forwarded link quotes nothing for
    // the person holding it.
    expect(QUOTE).toContain("await peekCustomerOffer({ token: input.offerToken, email: input.customer.email ?? \"\" })");
  });

  it("still refuses the gift below its own minimum, server-side", () => {
    expect(QUOTE).toContain("offerMinimumMet(offer, Math.round(subtotal * 100))");
  });

  it("the checkout hands the quote the client's items verbatim and prices them itself", () => {
    // No pre-pricing, no trusted totals: the route passes body.items straight
    // into the quote, whose only reading of them is id + quantity.
    expect(CREATE_SESSION).toContain("items: body.items,");
  });
});
