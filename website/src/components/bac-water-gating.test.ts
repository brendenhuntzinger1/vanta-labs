import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const UPSELL = read("src/components/bac-water-upsell.tsx");
const CART = read("src/components/cart-context.tsx");
const CATALOG = read("src/lib/catalog.ts");
const TYPES = read("src/lib/catalog-types.ts");

// Recommending bacteriostatic water for a product that ships as a liquid is
// wrong on the science, and this store sells to people who read labels.
describe("BAC Water is offered only for lyophilized products", () => {
  it("qualifies on the explicit flag, never on the slug alone", () => {
    // The old rule. If it comes back, every liquid gets the upsell again.
    expect(UPSELL).not.toMatch(/if \(!bacWater \|\| isBacWater\([a-zA-Z.]+\) \|\| offers\.length === 0\) return null;/);
    expect(UPSELL).toContain("needsReconstitution");
  });

  it("treats a missing flag as not eligible", () => {
    // `=== true` rather than truthiness: a product loaded before the column
    // existed, or a cart persisted before the field existed, must not qualify.
    expect(UPSELL).toContain("product?.requiresReconstitution === true");
    expect(UPSELL).toContain('detail.requiresReconstitution !== true');
  });

  it("gates all four surfaces", () => {
    // product page accessory block, frequently-bought-together, cart, popup
    expect(UPSELL.match(/needsReconstitution\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(UPSELL).toContain("cartNeedsReconstitution");
  });

  it("never infers eligibility from a name, category or dose label", () => {
    for (const guess of [/name\.match/i, /category === "/, /\.includes\("mg"\)/, /lyophili[sz]ed".*test\(/i]) {
      expect(UPSELL).not.toMatch(guess);
    }
  });

  it("carries the flag on the add-to-cart event, not just the cart", () => {
    // The popup reacts synchronously on dispatch, before React has re-rendered,
    // so reading the cart there returns state without the new line.
    expect(CART).toContain("requiresReconstitution: product.requiresReconstitution === true");
  });

  it("snapshots the flag onto the cart line for the cart reminder", () => {
    expect(CART).toContain("requiresReconstitution?: boolean;");
    expect(CART).toContain("record.requiresReconstitution === true");
  });

  it("reads the column from the catalog and exposes it on Product", () => {
    expect(CATALOG).toContain("requires_reconstitution");
    expect(CATALOG).toContain("requiresReconstitution: row.requires_reconstitution === true");
    expect(TYPES).toContain("requiresReconstitution?: boolean;");
  });
});

// Research-use-only store: the cross-sell must never drift into human-use copy.
describe("the BAC Water copy stays research-use only", () => {
  it("contains no human-use language", () => {
    for (const banned of [/\binject/i, /\bpatient/i, /\bdosage\b/i, /\btreatment\b/i, /\bmedication\b/i]) {
      expect(UPSELL).not.toMatch(banned);
    }
  });

  it("states research-use positioning and claims no purchase statistics", () => {
    expect(UPSELL).toContain("Not for human consumption");
    // "Commonly added with lyophilized materials" is a statement about lab
    // practice. A count of other customers would need an order query behind it.
    expect(UPSELL).not.toMatch(/\d+\s*(customers|people|others)\s+(also\s+)?(bought|added)/i);
  });
});
