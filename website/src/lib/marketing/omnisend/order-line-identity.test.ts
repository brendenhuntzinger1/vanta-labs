import { describe, expect, it } from "vitest";

import { omnisendVariantId } from "@/lib/marketing/omnisend/catalog-payload";
import { lineDoseId, lineSlug } from "@/lib/marketing/omnisend/orders";

// ---------------------------------------------------------------------------
// WHAT AN ORDER LINE ACTUALLY STORES, AND WHY NOTHING RESOLVED.
//
// `order_items.product_id` is not a product id. The checkout writes the cart
// line's composite id — `<slug>::<doseId>` — and rows from before doses existed
// carry a bare slug. loadOrderForOmnisend read it with `.in("id", productIds)`
// against `products.id`, which is a UUID column, so the lookup matched nothing
// on any order that has ever existed.
//
// PRODUCTION, 2026-09-17, counted rather than assumed:
//
//     line items                                 101
//     shaped like a UUID                           0
//     joining to products.id                       0
//     shaped "<slug>::<doseId>"                   93
//     bare slug                                    8
//     resolvable by slug prefix                   77
//
// It failed silently because every fallback looks plausible: productID became
// the raw "tesamorelin::b7f3…", productCategories became [], the image became
// the grey placeholder and the URL became /products. Mail renders; it renders
// wrong.
//
// These two parsers are the whole fix, so they are tested against the literal
// strings production holds rather than against invented ones.
// ---------------------------------------------------------------------------

describe("reading a slug out of an order line", () => {
  it("splits the composite id the checkout writes", () => {
    expect(lineSlug("tesamorelin::b7f39f3c-8b4b-46ff-ac9c-43341c6571ae")).toBe("tesamorelin");
    expect(lineDoseId("tesamorelin::b7f39f3c-8b4b-46ff-ac9c-43341c6571ae")).toBe("b7f39f3c-8b4b-46ff-ac9c-43341c6571ae");
  });

  it("reads a bare slug from the rows that predate doses", () => {
    // Eight live rows look like this. They must still resolve to a product.
    expect(lineSlug("bacteriostatic-water")).toBe("bacteriostatic-water");
    expect(lineDoseId("bacteriostatic-water")).toBeNull();
  });

  it("keeps a slug that contains dashes intact", () => {
    // The separator is "::" precisely because slugs use single dashes.
    expect(lineSlug("bpc-157-tb-500::a3b8e2f4-f7ef-4838-8f43-ae911bc1509a")).toBe("bpc-157-tb-500");
    expect(lineSlug("cjc-1295-ipamorelin::2103a963-d97a-49fa-a8a4-68c1c2a88bd5")).toBe("cjc-1295-ipamorelin");
  });

  it("is null for nothing, rather than an empty string that would query for ''", () => {
    for (const empty of [null, undefined, "", "   ", "::", "  ::  "]) {
      expect(lineSlug(empty), `${JSON.stringify(empty)} is not a slug`).toBeNull();
      expect(lineDoseId(empty), `${JSON.stringify(empty)} is not a dose`).toBeNull();
    }
  });

  it("never returns the raw composite, which is the bug it exists to prevent", () => {
    const raw = "glp-3::aec3c049-d453-4334-a130-7cbd1259b5f8";
    expect(lineSlug(raw)).not.toContain("::");
    expect(lineDoseId(raw)).not.toContain("::");
  });
});

describe("the line item and the catalogue meet in the middle", () => {
  it("a parsed line rebuilds exactly the variant id the catalogue holds", () => {
    // THE JOIN THE WHOLE THING IS FOR. catalog-payload builds the catalogue
    // variant as omnisendVariantId(slug, dose.id); an order line carries the
    // same two halves. Rebuilt here, the line names a variant Omnisend has —
    // which is what makes a product block render and a "bought X" segment
    // possible.
    const raw = "glp-1::eb2b70f4-0faa-4a2f-8376-f064b23959fd";
    const slug = lineSlug(raw)!;
    const dose = lineDoseId(raw)!;

    expect(omnisendVariantId(slug, dose)).toBe("glp-1__eb2b70f4-0faa-4a2f-8376-f064b23959fd");
    // And the product id is the bare slug, which is what the catalogue's
    // product id is. These two agreeing is the entire point.
    expect(slug).toBe("glp-1");
  });
});
