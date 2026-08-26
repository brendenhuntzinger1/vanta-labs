import { describe, expect, it } from "vitest";
import { resolveUnitCostCents } from "@/lib/quote-order";

// A dose whose cost is on file resolves to that cost. A dose whose cost is
// MISSING must resolve to null, never to the parent product's figure — the
// parent column holds inherited EvoLabs seed costs 1.4x-6.8x the true landed
// cost, and substituting it silently understated profit on four real orders.
//
// Exception: products with NO dose rows at all use their parent cost, which is
// authoritative for dose-less products (set only for products with no dose rows).
describe("resolveUnitCostCents", () => {
  const byDose = new Map<string, number>([["dose-1", 3.83]]);
  const bySlug = new Map<string, number>([["glp-1", 24.56], ["no-dose-product", 12.00]]);
  const slugsWithDoses = new Set<string>(["glp-1"]);
  const slugsWithoutDoses = new Set<string>();

  it("uses the dose cost when it is on file", () => {
    expect(resolveUnitCostCents("glp-1", "dose-1", byDose, bySlug, slugsWithDoses)).toBe(383);
  });

  it("returns null when the dose cost is missing, NOT the parent cost", () => {
    expect(resolveUnitCostCents("glp-1", "dose-2", byDose, bySlug, slugsWithDoses)).toBeNull();
  });

  it("returns null for a line with no dose variant", () => {
    expect(resolveUnitCostCents("glp-1", undefined, byDose, bySlug, slugsWithDoses)).toBeNull();
  });

  it("uses the parent cost for a dose-less product", () => {
    expect(resolveUnitCostCents("no-dose-product", undefined, byDose, bySlug, slugsWithoutDoses)).toBe(1200);
  });

  it("returns null for a dose-less product with no parent cost", () => {
    expect(resolveUnitCostCents("unknown-product", undefined, byDose, bySlug, slugsWithoutDoses)).toBeNull();
  });
});
