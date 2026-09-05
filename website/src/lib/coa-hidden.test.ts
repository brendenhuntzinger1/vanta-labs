import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COA_HIDDEN_PRODUCT_SLUGS,
  isCoaProductHidden,
  normalizeCoaHiddenProductSlugs,
} from "@/lib/coa-hidden";

// ---------------------------------------------------------------------------
// PRODUCTS THE OWNER HAS NOT SENT FOR TESTING MUST NOT SIT IN THE COA LIBRARY.
//
// HGH, HCG and bacteriostatic water were never part of the batch submitted to
// the laboratory, so a "Documentation Pending" card for each of them is a
// promise the store is not in a position to make. The library takes a hidden
// list from admin; until the owner saves one, the code default is exactly
// those products, so the change lands the day it deploys.
// ---------------------------------------------------------------------------

describe("the default hidden list", () => {
  it("hides the three product lines the owner did not test", () => {
    expect(DEFAULT_COA_HIDDEN_PRODUCT_SLUGS).toContain("hgh-gh-191");
    expect(DEFAULT_COA_HIDDEN_PRODUCT_SLUGS).toContain("hcg");
    expect(DEFAULT_COA_HIDDEN_PRODUCT_SLUGS).toContain("bacteriostatic-water");
  });

  it("names only slugs the catalogue's SQL actually publishes", () => {
    const setup = readFileSync(join(process.cwd(), "src/lib/sql/SETUP-run-all.sql"), "utf8");
    const bacWater = readFileSync(join(process.cwd(), "src/lib/bac-water.ts"), "utf8");
    for (const slug of DEFAULT_COA_HIDDEN_PRODUCT_SLUGS) {
      // The retired HGH slug and the second BAC water slug live in the
      // reconciliation / cross-sell lists rather than the seed; either source
      // counts, an invented slug does not.
      expect(setup.includes(`'${slug}'`) || bacWater.includes(`"${slug}"`)).toBe(true);
    }
  });

  it("does not hide a documented compound", () => {
    expect(DEFAULT_COA_HIDDEN_PRODUCT_SLUGS).not.toContain("bpc-157");
    expect(DEFAULT_COA_HIDDEN_PRODUCT_SLUGS).not.toContain("tirzepatide");
  });
});

describe("normalizeCoaHiddenProductSlugs", () => {
  it("returns null when nothing has been saved, so the caller falls back to the default", () => {
    expect(normalizeCoaHiddenProductSlugs(undefined)).toBeNull();
    expect(normalizeCoaHiddenProductSlugs(null)).toBeNull();
    expect(normalizeCoaHiddenProductSlugs("hcg")).toBeNull();
    expect(normalizeCoaHiddenProductSlugs({ slugs: ["hcg"] })).toBeNull();
  });

  it("treats a saved empty list as 'hide nothing', not as 'unset'", () => {
    // The owner clearing every box is a decision. It must not silently
    // re-hide the default three.
    expect(normalizeCoaHiddenProductSlugs([])).toEqual([]);
  });

  it("lower-cases, trims, de-duplicates and drops anything that is not a slug", () => {
    expect(normalizeCoaHiddenProductSlugs([" HCG ", "hcg", "hgh-gh-191", 42, "", null, "not a slug!"])).toEqual([
      "hcg",
      "hgh-gh-191",
    ]);
  });

  it("caps a runaway list rather than storing it", () => {
    const many = Array.from({ length: 1000 }, (_, index) => `product-${index}`);
    expect(normalizeCoaHiddenProductSlugs(many)?.length).toBeLessThanOrEqual(200);
  });
});

describe("isCoaProductHidden", () => {
  it("matches on slug, case-insensitively", () => {
    expect(isCoaProductHidden({ slug: "HCG" }, ["hcg"])).toBe(true);
    expect(isCoaProductHidden("hgh-gh-191", ["hcg", "hgh-gh-191"])).toBe(true);
  });

  it("never matches on name — hiding is an explicit choice per product", () => {
    const product: { slug: string; name: string } = { slug: "bpc-157", name: "HCG" };
    expect(isCoaProductHidden(product, ["hcg"])).toBe(false);
  });

  it("treats a blank slug or empty list as visible", () => {
    expect(isCoaProductHidden({ slug: "" }, ["hcg"])).toBe(false);
    expect(isCoaProductHidden("hcg", [])).toBe(false);
    expect(isCoaProductHidden(null, ["hcg"])).toBe(false);
  });
});
