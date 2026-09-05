import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COA_BATCH_NUMBER, DEFAULT_COA_PURITY } from "@/lib/coa-defaults";
import { formatCoaPurity } from "@/lib/coa-format";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the admin prefills", () => {
  it("state the owner's standing facts: above 99% purity, batch Vanta184290", () => {
    expect(DEFAULT_COA_PURITY).toBe(">99%");
    expect(DEFAULT_COA_BATCH_NUMBER).toBe("Vanta184290");
  });

  it("survive the purity formatter unchanged, so a record shows exactly what was typed", () => {
    expect(formatCoaPurity(DEFAULT_COA_PURITY)).toBe(">99%");
  });

  it("seed every new dose the products admin can create", () => {
    const source = read("src/app/admin/products/page.tsx");
    // The wizard's first dose, the wizard reset, and the "add dose" button.
    expect(source.match(/batchNumber: DEFAULT_COA_BATCH_NUMBER,/g)).toHaveLength(3);
    expect(source.match(/purityResult: DEFAULT_COA_PURITY,/g)).toHaveLength(3);
    expect(source).not.toMatch(/batchNumber: "",/);
    expect(source).not.toMatch(/purityResult: "",/);
  });

  it("seed every new COA record draft, including the by-dose batch", () => {
    const source = read("src/app/admin/coa/page.tsx");
    expect(source).toContain("batchNumber: DEFAULT_COA_BATCH_NUMBER,");
    expect(source).toContain("purity: DEFAULT_COA_PURITY,");
  });
});

// A prefill the operator sees and saves is data. The same string reached for
// when a row is blank would be a purity claim with nothing behind it, which is
// the one thing a COA surface must never do. So the storefront may not know
// these constants exist.
describe("the storefront never falls back to them", () => {
  it.each([
    "src/components/product-detail-client.tsx",
    "src/app/coa-library/coa-library-client.tsx",
    "src/lib/catalog.ts",
    "src/lib/coa.ts",
  ])("%s does not import coa-defaults", (path) => {
    expect(read(path)).not.toContain("coa-defaults");
  });
});
