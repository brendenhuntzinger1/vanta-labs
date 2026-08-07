import { describe, expect, it } from "vitest";
import { DEFAULT_UNIT_WEIGHT_OZ } from "@/lib/shippo/parcel";

// ---------------------------------------------------------------------------
// "Is this parcel's weight a guess?" -- the question parcel_weight_estimated
// answers, and the one the admin's "Weight review required" banner is driven by.
//
// There are two ways to answer it, and only one of them survives contact with
// the catalogue.
// ---------------------------------------------------------------------------

/** How order-sync used to decide: compare the unit weight to the default. */
function estimatedByValue(lines: Array<{ unitWeightOz: number }>): boolean {
  return lines.some((line) => line.unitWeightOz === DEFAULT_UNIT_WEIGHT_OZ);
}

/** How it decides now: did the SKU actually have a weight on file? */
function estimatedByProvenance(lines: Array<{ hasStoredWeight: boolean }>): boolean {
  return lines.some((line) => !line.hasStoredWeight);
}

describe("deciding whether a parcel weight is estimated", () => {
  // The catalogue default IS the real peptide weight -- 10 g, 0.36 oz -- because
  // a fallback that isn't a plausible vial is a worse fallback. That makes the
  // value itself useless as evidence: a correctly-weighed peptide and an
  // unweighed one produce the identical number.
  it("value comparison flags a correctly-weighed peptide as a guess", () => {
    const properlyWeighed = [{ unitWeightOz: 0.36, hasStoredWeight: true }];

    expect(estimatedByValue(properlyWeighed)).toBe(true); // wrong
    expect(estimatedByProvenance(properlyWeighed)).toBe(false); // right
  });

  it("provenance still catches a SKU with no weight on file", () => {
    const unweighed = [{ unitWeightOz: DEFAULT_UNIT_WEIGHT_OZ, hasStoredWeight: false }];

    expect(estimatedByProvenance(unweighed)).toBe(true);
  });

  // The inverse failure, and the more expensive one: a heavy SKU that was never
  // weighed does not equal the default, so value comparison calls it measured
  // and the parcel under-declares with nothing flagged.
  it("value comparison misses an unweighed SKU whose fallback was overridden", () => {
    const heavyUnweighed = [{ unitWeightOz: 2.3, hasStoredWeight: false }];

    expect(estimatedByValue(heavyUnweighed)).toBe(false); // wrong
    expect(estimatedByProvenance(heavyUnweighed)).toBe(true); // right
  });

  it("a fully weighed mixed order is not an estimate", () => {
    const mixed = [
      { unitWeightOz: 0.36, hasStoredWeight: true },
      { unitWeightOz: 1.06, hasStoredWeight: true },
      { unitWeightOz: 2.3, hasStoredWeight: true },
    ];

    expect(estimatedByProvenance(mixed)).toBe(false);
  });

  it("one unweighed line makes the whole parcel an estimate", () => {
    const mixed = [
      { unitWeightOz: 0.36, hasStoredWeight: true },
      { unitWeightOz: 0.36, hasStoredWeight: false },
    ];

    expect(estimatedByProvenance(mixed)).toBe(true);
  });
});
