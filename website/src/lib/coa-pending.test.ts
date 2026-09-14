import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COA_SUPPORT_EMAIL,
  COA_TESTING_PENDING_BODY,
  COA_TESTING_PENDING_HEADING,
  COA_TESTING_PENDING_SHORT,
  isCoaTestingPending,
} from "@/lib/coa-pending";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LIBRARY_CARD = read("src/app/coa-library/coa-library-client.tsx");
const PRODUCT_DETAIL = read("src/components/product-detail-client.tsx");
const PRODUCT_CARD = read("src/components/product-card.tsx");
const PENDING_DIALOG = read("src/components/coa-pending-dialog.tsx");

describe("isCoaTestingPending", () => {
  it("treats every compound without a document as one whose certificate is on its way", () => {
    // Callers already know the product has no published COA; this only
    // decides whether the store may say the certificate is coming.
    for (const slug of ["tesamorelin", "hgh-gh-191", "hcg", "cjc-1295-no-dac", "5-amino-1mq", "mots-c", "bpc-157"]) {
      expect(isCoaTestingPending(slug)).toBe(true);
      expect(isCoaTestingPending({ slug })).toBe(true);
    }
  });

  it("never says a solvent is at a laboratory", () => {
    for (const slug of ["recon-water", "bac-water", "bacteriostatic-water", "bac-water-30ml"]) {
      expect(isCoaTestingPending(slug)).toBe(false);
      expect(isCoaTestingPending({ slug })).toBe(false);
    }
    // The name is enough on its own: a solvent republished under a new slug
    // must not start claiming a laboratory report.
    expect(isCoaTestingPending({ slug: "solvent-10ml", name: "Recon water (0.9% Benzyl Alcohol)" })).toBe(false);
  });

  it("survives the casing and padding a slug picks up in transit", () => {
    expect(isCoaTestingPending("  HCG  ")).toBe(true);
    expect(isCoaTestingPending("RECON-WATER")).toBe(false);
  });

  it("treats absent input as not pending rather than throwing", () => {
    for (const junk of [null, undefined, "", "   ", {}, { slug: null }]) {
      expect(isCoaTestingPending(junk as never)).toBe(false);
    }
  });
});

describe("the copy", () => {
  it("says the certificate is returning from the laboratory", () => {
    expect(COA_TESTING_PENDING_HEADING).toMatch(/returning from the laboratory/i);
    for (const copy of [COA_TESTING_PENDING_SHORT, COA_TESTING_PENDING_BODY]) {
      expect(copy).toMatch(/laboratory/i);
    }
  });

  it("promises publication rather than only reporting an absence", () => {
    for (const copy of [COA_TESTING_PENDING_SHORT, COA_TESTING_PENDING_BODY]) {
      expect(copy).toMatch(/will be published/i);
    }
  });

  it("never claims a completed test or a purity figure it cannot show", () => {
    for (const copy of [COA_TESTING_PENDING_HEADING, COA_TESTING_PENDING_SHORT, COA_TESTING_PENDING_BODY]) {
      expect(copy).not.toMatch(/tested to|verified|\d+(\.\d+)?%/i);
    }
  });

  it("points questions at the address the footer already publishes", () => {
    expect(COA_SUPPORT_EMAIL).toBe("support@vantalabsresearch.com");
    expect(read("src/components/site-footer.tsx")).toContain(`mailto:${COA_SUPPORT_EMAIL}`);
  });
});

// Every COA surface has to carry this, or a shopper gets the explanation on
// one page and a bare "not published yet" — or nothing at all — on another.
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

  it("is used by the catalogue card, gated on the product having no document", () => {
    expect(PRODUCT_CARD).toContain("const coaPending = !coaHref && isCoaTestingPending(product);");
    expect(PRODUCT_CARD).toContain("CoaPendingDialog");
  });

  it("the dialog reads the heading, the short copy and the support address from here", () => {
    expect(PENDING_DIALOG).toContain("COA_TESTING_PENDING_HEADING");
    expect(PENDING_DIALOG).toContain("COA_TESTING_PENDING_SHORT");
    expect(PENDING_DIALOG).toContain("COA_SUPPORT_EMAIL");
  });

  it("hard-codes the copy in no surface, so they cannot drift", () => {
    for (const source of [LIBRARY_CARD, PRODUCT_DETAIL, PRODUCT_CARD, PENDING_DIALOG]) {
      expect(source).not.toContain(COA_TESTING_PENDING_HEADING);
      expect(source).not.toContain(COA_TESTING_PENDING_SHORT);
      expect(source).not.toContain(COA_TESTING_PENDING_BODY);
    }
  });
});
