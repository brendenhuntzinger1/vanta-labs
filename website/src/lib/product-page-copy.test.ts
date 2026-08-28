import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// THE PRODUCT PAGE'S INTERPOLATED COPY, READ AS A CUSTOMER SEES IT.
//
// Two separate strings on this page were assembled from a template with a
// separator baked into it, and each rendered a separator with nothing on one
// side of it:
//
//   `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`
//        -> "ADD 2 × TO CART"  — a multiplication sign multiplying nothing.
//           Reproduced in the browser on the local harness by selecting the
//           2-vial bundle on /products/bpc-157-10mg.
//
//   `${doseFromSlug} · ${product.labName}`
//        -> "10MG · "          — every one of the 38 production products has a
//           NULL lab_name, so the separator only ever had one side.
//
// Neither is a crash and neither has a test that could see it, because both
// are correct for the value the developer had in front of them and wrong for
// the one the store actually ships. So this file reads the strings the way a
// customer does: a separator is only allowed when something can be on both
// sides of it.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(new URL("../components/product-detail-client.tsx", import.meta.url), "utf8");

/** The file with // and /* *​/ comments removed, so prose can't satisfy a scan. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the product page's add-to-cart label", () => {
  // Exactly the expression in the component, evaluated the way React does.
  const label = (quantity: number) => `Add ${quantity > 1 ? `${quantity} ` : ""}to Cart`;

  it("reads as a sentence at every quantity the bundle selector offers", () => {
    // BUNDLE_OPTIONS: 1, 2, 3, 5, 10 — plus a custom quantity in between.
    expect([1, 2, 3, 4, 5, 10].map(label)).toEqual([
      "Add to Cart",
      "Add 2 to Cart",
      "Add 3 to Cart",
      "Add 4 to Cart",
      "Add 5 to Cart",
      "Add 10 to Cart",
    ]);
  });

  it("never renders a separator with nothing after it", () => {
    for (const quantity of [1, 2, 3, 5, 10]) {
      expect(label(quantity)).not.toMatch(/[×·|–—-]\s*(to Cart|$)/);
    }
  });
});

describe("the product page source", () => {
  const code = withoutComments(SOURCE);

  it("does not build the add-to-cart label with a trailing separator", () => {
    // The exact defect: a separator inside the conditional half of the
    // template, so it survives even when the half after it is empty.
    expect(code).not.toMatch(/Add \$\{[^}]*\}?[^`]*[×·]\s*`\s*:/);
    expect(code).toContain('`Add ${quantity > 1 ? `${quantity} ` : ""}to Cart`');
  });

  it("guards the dose line with the value that follows the separator", () => {
    // `${doseFromSlug} · ${labName}` unconditionally would print "10MG · " for
    // all 38 production products, every one of which has a null lab_name.
    expect(code).toContain("product.labName ? `${doseFromSlug} · ${product.labName}` : doseFromSlug");
  });
});
