import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COA_TESTING_PENDING_BODY,
  COA_TESTING_PENDING_SHORT,
  COA_TESTING_PENDING_SLUGS,
  isCoaTestingPending,
} from "@/lib/coa-pending";

const LIBRARY_CARD = readFileSync(
  join(process.cwd(), "src/app/coa-library/coa-library-client.tsx"),
  "utf8",
);
const PRODUCT_DETAIL = readFileSync(
  join(process.cwd(), "src/components/product-detail-client.tsx"),
  "utf8",
);

describe("isCoaTestingPending", () => {
  it("recognises the HGH and HCG slugs the catalogue actually publishes", () => {
    // From public.products: "hgh-gh-191" and "hcg" are live, "hgh-191aa" is the
    // retired HGH row reconcile-catalog.sql maps onto "hgh-gh-191".
    expect(isCoaTestingPending("hgh-gh-191")).toBe(true);
    expect(isCoaTestingPending("hcg")).toBe(true);
    expect(isCoaTestingPending("hgh-191aa")).toBe(true);
  });

  it("takes a product object or a bare slug", () => {
    expect(isCoaTestingPending({ slug: "hcg" })).toBe(true);
    expect(isCoaTestingPending({ slug: "bpc-157" })).toBe(false);
  });

  it("does not match every other product in the catalogue", () => {
    for (const slug of ["bpc-157", "glp-1", "nad", "tesamorelin", "ghrp-2", "kisspeptin"]) {
      expect(isCoaTestingPending(slug)).toBe(false);
    }
  });

  it("matches on slug, never on name — a claim shown to customers must not over-match", () => {
    // A future "HGH Fragment 176-191" would carry the word but not the fact.
    expect(isCoaTestingPending({ slug: "hgh-fragment-176-191", name: "HGH Fragment 176-191" } as { slug: string })).toBe(
      false,
    );
    expect(isCoaTestingPending({ slug: "hcg-blend", name: "HCG" } as { slug: string })).toBe(false);
  });

  it("survives the casing and padding a slug picks up in transit", () => {
    expect(isCoaTestingPending("  HCG  ")).toBe(true);
    expect(isCoaTestingPending("HGH-GH-191")).toBe(true);
  });

  it("treats absent input as not pending rather than throwing", () => {
    for (const junk of [null, undefined, "", "   ", {}, { slug: null }]) {
      expect(isCoaTestingPending(junk as never)).toBe(false);
    }
  });
});

describe("the copy", () => {
  it("promises publication rather than only reporting an absence", () => {
    for (const copy of [COA_TESTING_PENDING_SHORT, COA_TESTING_PENDING_BODY]) {
      expect(copy).toMatch(/will be published/i);
    }
  });

  it("never claims a completed test or a purity figure it cannot show", () => {
    for (const copy of [COA_TESTING_PENDING_SHORT, COA_TESTING_PENDING_BODY]) {
      expect(copy).not.toMatch(/tested to|verified|\d+(\.\d+)?%/i);
    }
  });
});

// Both COA surfaces have to carry this, or a shopper gets the explanation on
// one page and a bare "not published yet" on the other.
describe("the surfaces that render it", () => {
  it("is used by the COA library card, gated on the product being undocumented", () => {
    expect(LIBRARY_CARD).toContain("isCoaTestingPending(product.slug)");
    expect(LIBRARY_CARD).toContain("COA_TESTING_PENDING_SHORT");
    expect(LIBRARY_CARD).toContain("const awaitingTesting = !verified &&");
  });

  it("is used by the product page's COA tab, gated on zero published records", () => {
    expect(PRODUCT_DETAIL).toContain("isCoaTestingPending(product)");
    expect(PRODUCT_DETAIL).toContain("COA_TESTING_PENDING_BODY");
    expect(PRODUCT_DETAIL).toContain("coaDocuments.length === 0 && isCoaTestingPending(product)");
  });

  it("keeps the generic pending line for products that are not on the list", () => {
    expect(LIBRARY_CARD).toContain("Batch documentation has not been published yet.");
  });

  it("hard-codes the copy in neither surface, so the two cannot drift", () => {
    for (const source of [LIBRARY_CARD, PRODUCT_DETAIL]) {
      expect(source).not.toContain(COA_TESTING_PENDING_SHORT);
      expect(source).not.toContain(COA_TESTING_PENDING_BODY);
    }
  });

  it("lists only slugs that exist in the catalogue's SQL", () => {
    const setup = readFileSync(join(process.cwd(), "src/lib/sql/SETUP-run-all.sql"), "utf8");
    for (const slug of COA_TESTING_PENDING_SLUGS) {
      expect(setup).toContain(`'${slug}'`);
    }
  });
});
