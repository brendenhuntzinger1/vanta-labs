import { describe, expect, it } from "vitest";
import { resolveUnitCostCents } from "@/lib/quote-order";

// A dose whose cost is on file resolves to that cost. A dose whose cost is
// MISSING must resolve to null, never to the parent product's figure — the
// parent column holds inherited EvoLabs seed costs 1.4x-6.8x the true landed
// cost, and substituting it silently understated profit on four real orders.
describe("resolveUnitCostCents", () => {
  const byDose = new Map<string, number>([["dose-1", 3.83]]);
  const bySlug = new Map<string, number>([["glp-1", 24.56]]);

  it("uses the dose cost when it is on file", () => {
    expect(resolveUnitCostCents("glp-1", "dose-1", byDose, bySlug)).toBe(383);
  });

  it("returns null when the dose cost is missing, NOT the parent cost", () => {
    expect(resolveUnitCostCents("glp-1", "dose-2", byDose, bySlug)).toBeNull();
  });

  it("returns null for a line with no dose at all", () => {
    expect(resolveUnitCostCents("glp-1", undefined, byDose, bySlug)).toBeNull();
  });
});
