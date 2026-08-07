import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIT_WEIGHT_OZ,
  computeParcelWeightOz,
  gramsToOz,
  ozToGrams,
} from "@/lib/shippo/parcel";

// The catalogue, in the units the owner actually weighs in.
const PEPTIDE_G = 10; // 3ml vial
const BAC_10ML_G = 30;
const BAC_30ML_G = 65;
const MAILER_G = 30; // bubble mailer + packing material

const PEPTIDE_OZ = gramsToOz(PEPTIDE_G);
const BAC_10_OZ = gramsToOz(BAC_10ML_G);
const BAC_30_OZ = gramsToOz(BAC_30ML_G);

const MAILER = {
  lengthIn: 8,
  widthIn: 4,
  heightIn: 1,
  emptyWeightOz: gramsToOz(MAILER_G),
};

function parcel(items: Array<{ quantity: number; productWeightOz?: number | null }>) {
  return computeParcelWeightOz({ preset: MAILER, items });
}

/** What the parcel should weigh, in the same arithmetic a human would do. */
function expected(...lines: Array<[oz: number, qty: number]>) {
  const merch = lines.reduce((total, [oz, qty]) => total + oz * qty, 0);
  return Math.round((MAILER.emptyWeightOz + merch) * 100) / 100;
}

describe("gram conversion", () => {
  it("rounds UP, because under-declaring is what earns a carrier adjustment", () => {
    // 10 g is 0.3527 oz. Rounding to nearest would give 0.35 and declare light.
    expect(gramsToOz(10)).toBe(0.36);
    expect(gramsToOz(30)).toBe(1.06);
    expect(gramsToOz(65)).toBe(2.3);
  });

  it("round-trips close enough to recognise the original figure", () => {
    expect(ozToGrams(gramsToOz(10))).toBeGreaterThanOrEqual(10);
    expect(ozToGrams(gramsToOz(10))).toBeLessThanOrEqual(11);
    expect(ozToGrams(gramsToOz(65))).toBeGreaterThanOrEqual(65);
    expect(ozToGrams(gramsToOz(65))).toBeLessThanOrEqual(66);
  });

  it("treats zero and nonsense as zero rather than NaN", () => {
    expect(gramsToOz(0)).toBe(0);
    expect(gramsToOz(Number.NaN)).toBe(0);
    expect(ozToGrams(-5)).toBe(0);
  });
});

describe("quantity multiplication", () => {
  it.each([1, 2, 5, 10, 25])("scales linearly for %i peptide vials", (qty) => {
    expect(parcel([{ quantity: qty, productWeightOz: PEPTIDE_OZ }])).toBe(expected([PEPTIDE_OZ, qty]));
  });

  // The specific failure this guards: adding packaging once per LINE instead of
  // once per parcel. A single-item order hides it; a multi-item order does not.
  it("adds the mailer exactly once regardless of how many lines there are", () => {
    const oneLine = parcel([{ quantity: 4, productWeightOz: PEPTIDE_OZ }]);
    const fourLines = parcel([
      { quantity: 1, productWeightOz: PEPTIDE_OZ },
      { quantity: 1, productWeightOz: PEPTIDE_OZ },
      { quantity: 1, productWeightOz: PEPTIDE_OZ },
      { quantity: 1, productWeightOz: PEPTIDE_OZ },
    ]);
    expect(fourLines).toBe(oneLine);
  });
});

describe("the real catalogue", () => {
  it("1 x 10ml bacteriostatic water", () => {
    expect(parcel([{ quantity: 1, productWeightOz: BAC_10_OZ }])).toBe(expected([BAC_10_OZ, 1]));
  });

  it("1 x 30ml bacteriostatic water", () => {
    expect(parcel([{ quantity: 1, productWeightOz: BAC_30_OZ }])).toBe(expected([BAC_30_OZ, 1]));
  });

  it("2 peptides + 1 x 10ml BAC water", () => {
    expect(
      parcel([
        { quantity: 2, productWeightOz: PEPTIDE_OZ },
        { quantity: 1, productWeightOz: BAC_10_OZ },
      ]),
    ).toBe(expected([PEPTIDE_OZ, 2], [BAC_10_OZ, 1]));
  });

  it("a mixed order across three SKUs at different quantities", () => {
    expect(
      parcel([
        { quantity: 3, productWeightOz: PEPTIDE_OZ },
        { quantity: 2, productWeightOz: BAC_10_OZ },
        { quantity: 1, productWeightOz: BAC_30_OZ },
      ]),
    ).toBe(expected([PEPTIDE_OZ, 3], [BAC_10_OZ, 2], [BAC_30_OZ, 1]));
  });

  // Sanity check against the tier that actually costs money: USPS Ground
  // Advantage prices its first band at 4 oz, and a typical order must not
  // silently cross it because the arithmetic drifted.
  it("keeps a five-vial order inside the first USPS weight band", () => {
    expect(parcel([{ quantity: 5, productWeightOz: PEPTIDE_OZ }])).toBeLessThan(4);
  });
});

describe("a product with no stored weight", () => {
  it("falls back to the catalog default rather than weighing nothing", () => {
    // Never zero: a zero-weight parcel is rejected by carriers, and worse, a
    // silently-zero line would under-declare the whole shipment.
    const withFallback = parcel([{ quantity: 2, productWeightOz: null }]);
    expect(withFallback).toBe(expected([DEFAULT_UNIT_WEIGHT_OZ, 2]));
    expect(withFallback).toBeGreaterThan(MAILER.emptyWeightOz);
  });

  it("still counts the packaging when every line is unweighed", () => {
    expect(parcel([{ quantity: 1, productWeightOz: null }])).toBeGreaterThan(MAILER.emptyWeightOz);
  });
});

describe("declared weight is never zero", () => {
  it("floors an empty parcel above zero so a carrier will accept it", () => {
    expect(computeParcelWeightOz({ preset: { ...MAILER, emptyWeightOz: 0 }, items: [] })).toBeGreaterThan(0);
  });
});
