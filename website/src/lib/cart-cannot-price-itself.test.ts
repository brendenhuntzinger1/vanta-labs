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
    //
    // THIS USED TO PIN THE CALL AS A LITERAL, reading `email:
    // input.customer.email ?? ""` off the source. The address moved into a
    // named value on 2026-09-19 (see `offerEmail`), so the literal no longer
    // matches — but the literal was never the property. The property is that
    // BOTH arguments are present and both are server-derived, and that is what
    // is asserted now.
    const peek = QUOTE.slice(QUOTE.indexOf("await peekCustomerOffer({"));
    expect(peek.slice(0, 160), "the offer must still be fetched by its token").toContain("token: input.offerToken");
    expect(peek.slice(0, 160), "an offer fetched without an address is one anybody can spend")
      .toContain("email: offerAddress");
    // And the address is derived, not accepted: either the express lane's one
    // named address or the contact this quote is already pricing for.
    expect(QUOTE).toContain('const offerAddress = String(input.offerEmail ?? input.customer.email ?? "");');
  });

  it("never lets the CLIENT name the address that owns a prize", () => {
    // `offerEmail` was added for the express lane and is the one input that
    // could, if wired carelessly, let a request nominate whose prize to spend.
    // It has exactly two call sites and both read a server value: the session
    // route from the verified session, and the authorize route from the frozen
    // intent row. A body field reaching this would be the whole store's worst
    // bug, so it is pinned here rather than left to review.
    const SESSION = withoutComments(read("src/app/api/checkout/express/session/route.ts"));
    const AUTHORIZE = withoutComments(read("src/app/api/checkout/express/authorize/route.ts"));

    expect(SESSION, "the sheet must name the VERIFIED session's address").toContain("offerEmail: customerEmail,");
    expect(SESSION).toContain('const customerEmail = isCustomer ? (authenticatedUser!.email ?? "").trim().toLowerCase() : "";');

    expect(AUTHORIZE, "the charge must name the frozen intent's address")
      .toContain('offerEmail: intent.customer_email ?? "",');

    // Nothing anywhere reads it off a request body.
    for (const source of [SESSION, AUTHORIZE]) {
      expect(source).not.toMatch(/offerEmail:\s*body\./);
      expect(source).not.toMatch(/offerEmail:\s*walletContact/);
    }
    // The card lane does not set it at all, so its behaviour is unchanged.
    expect(withoutComments(CREATE_SESSION)).not.toContain("offerEmail:");
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
