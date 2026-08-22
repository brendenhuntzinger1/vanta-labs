import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBacWater } from "@/lib/bac-water";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const UPSELL = read("src/components/bac-water-upsell.tsx");

// The offer is intentionally broad: every published product may be offered
// bacteriostatic water, whatever form it ships in, and the customer declines if
// they do not need it. The catalogue holds no formulation data to classify
// from, so a form-gated offer would depend on a hand-maintained flag that goes
// silently wrong the first time somebody forgets to set it.
describe("BAC Water is offered for any published product", () => {
  it("does not gate the offer on requires_reconstitution", () => {
    expect(UPSELL).not.toContain("needsReconstitution");
    expect(UPSELL).not.toMatch(/if \(detail\.requiresReconstitution !== true\) return;/);
    expect(UPSELL).not.toContain("cartNeedsReconstitution");
  });

  it("infers physical form from nothing at all", () => {
    for (const guess of [
      /lyophili[sz]ed"\s*\)/i,
      /includes\("mg"\)/,
      /includes\("ml"\)/i,
      /endsWith\("iu"\)/i,
      /category === "/,
    ]) {
      expect(UPSELL).not.toMatch(guess);
    }
  });
});

// A cross-sell that offers a product to itself is a loop.
describe("bacteriostatic water is excluded from its own offer", () => {
  it("matches both published BAC Water SKUs, not just the offered slug", () => {
    expect(isBacWater("bacteriostatic-water")).toBe(true);
    expect(isBacWater("bac-water-30ml")).toBe(true);
    expect(isBacWater({ slug: "bac-water-30ml", name: "Bacteriostatic Water 30ml" })).toBe(true);
  });

  it("matches a future BAC Water SKU by name as a safety net", () => {
    // Over-matching costs one missed cross-sell; under-matching is a recursive
    // offer, so exclusion errs wide on purpose.
    expect(isBacWater({ slug: "bac-water-10ml", name: "Bacteriostatic Water 10mL" })).toBe(true);
    expect(isBacWater({ slug: "sterile-diluent", name: "Bacteriostatic Water (BAC)" })).toBe(true);
  });

  it("does not match ordinary products", () => {
    for (const p of [
      { slug: "bpc-157", name: "BPC-157" },
      { slug: "lipo-c-10ml", name: "LIPO-C 10mL" },
      { slug: "glp-1-30mg", name: "GLP-1 30mg" },
      { slug: "hcg-5000iu", name: "HCG 5000iu" },
    ]) {
      expect(isBacWater(p)).toBe(false);
    }
    expect(isBacWater(null)).toBe(false);
    expect(isBacWater(undefined)).toBe(false);
    expect(isBacWater("")).toBe(false);
  });

  it("guards every surface against the loop", () => {
    // product page, frequently-bought-together, cart reminder, popup
    expect(UPSELL.match(/isBacWater\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(UPSELL).toContain("hasNonBacWaterItem");
  });
});

// Research-use-only store, and the offer now reaches products that may not
// need it — so it must never assert that this product requires reconstituting.
describe("the copy stays optional and research-use only", () => {
  it("never claims the product requires reconstitution", () => {
    expect(UPSELL).not.toMatch(/supplied in lyophilized form/i);
    expect(UPSELL).not.toMatch(/you need bacteriostatic water/i);
    expect(UPSELL).toContain("Need bacteriostatic water?");
    expect(UPSELL).toContain("Add it if your");
  });

  it("contains no human-use language", () => {
    for (const banned of [/\binject/i, /\bpatient/i, /\bdosage\b/i, /\btreatment\b/i, /\bmedication\b/i]) {
      expect(UPSELL).not.toMatch(banned);
    }
    expect(UPSELL).toContain("Not for human consumption");
  });

  it("claims no purchase statistics", () => {
    expect(UPSELL).not.toMatch(/\d+\s*(customers|people|others)\s+(also\s+)?(bought|added)/i);
  });
});
