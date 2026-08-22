import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIT_WEIGHT_OZ,
  FALLBACK_PACKAGE_PRESET,
  MIN_PARCEL_WEIGHT_OZ,
  buildParcel,
  computeParcelWeightOz,
  LIQUID_DENSITY_G_PER_ML,
  gramsToOz,
  hasStoredWeight,
  lineWeightOz,
  liquidFallbackWeightOz,
  parseDoseVolumeMl,
  resolvePackagePreset,
} from "@/lib/shippo/parcel";
import { parseAmountToCents } from "@/lib/shippo/client";

// Parcel weight decides what postage we buy. Under-declaring is postage due and
// a returned package; over-declaring costs cents. Every case below pins one of
// the fallbacks that keep the number on the safe side of that trade.

const MAILER = { lengthIn: 9, widthIn: 6, heightIn: 3, emptyWeightOz: 1.5 };

describe("lineWeightOz", () => {
  it("prefers the dose weight over the product weight", () => {
    expect(lineWeightOz({ doseWeightOz: 5, productWeightOz: 2 })).toBe(5);
  });

  it("inherits the product weight when the dose declares none", () => {
    // A null product_doses.shipping_weight_oz means "inherit the parent".
    expect(lineWeightOz({ doseWeightOz: null, productWeightOz: 3.25 })).toBe(3.25);
    expect(lineWeightOz({ productWeightOz: 3.25 })).toBe(3.25);
  });

  it("falls back to the default unit weight when nothing is declared", () => {
    expect(lineWeightOz({})).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz({ doseWeightOz: null, productWeightOz: null })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz(undefined)).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz(null)).toBe(DEFAULT_UNIT_WEIGHT_OZ);
  });

  it("accepts a raw joined row in snake_case", () => {
    expect(lineWeightOz({ dose_shipping_weight_oz: 4 })).toBe(4);
    expect(lineWeightOz({ product_shipping_weight_oz: 6 })).toBe(6);
    expect(lineWeightOz({ dose_shipping_weight_oz: 4, product_shipping_weight_oz: 6 })).toBe(4);
  });

  it("accepts numeric columns that arrive as strings", () => {
    expect(lineWeightOz({ doseWeightOz: "2.5" })).toBe(2.5);
    expect(lineWeightOz({ productWeightOz: "7" })).toBe(7);
  });

  it("treats a zero or negative weight as missing data, not as a weightless item", () => {
    // A 0 in the column is a mis-typed row or an unfilled import. Honouring it
    // would ship a real vial declared as nothing.
    expect(lineWeightOz({ doseWeightOz: 0, productWeightOz: 3 })).toBe(3);
    expect(lineWeightOz({ doseWeightOz: -1, productWeightOz: 3 })).toBe(3);
    expect(lineWeightOz({ doseWeightOz: 0, productWeightOz: 0 })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz({ productWeightOz: "not a number" })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz({ productWeightOz: "" })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
  });
});

describe("computeParcelWeightOz", () => {
  it("adds the packaging weight exactly once, whatever the item count", () => {
    const oneItem = computeParcelWeightOz({ preset: MAILER, items: [{ productWeightOz: 2, quantity: 1 }] });
    expect(oneItem).toBe(1.5 + 2);

    const threeItems = computeParcelWeightOz({
      preset: MAILER,
      items: [
        { productWeightOz: 2, quantity: 1 },
        { productWeightOz: 2, quantity: 1 },
        { productWeightOz: 2, quantity: 1 },
      ],
    });
    expect(threeItems).toBe(1.5 + 6);
  });

  it("multiplies each line's unit weight by its quantity", () => {
    expect(
      computeParcelWeightOz({
        preset: MAILER,
        items: [
          { productWeightOz: 2, quantity: 3 },
          { doseWeightOz: 5, productWeightOz: 2, quantity: 2 },
        ],
      }),
    ).toBe(1.5 + 6 + 10);
  });

  it("uses the default unit weight for items with no declared weight", () => {
    // Rounded to hundredths, not compared against the raw arithmetic: the
    // function rounds deliberately, and 1.5 + 0.18 * 4 evaluates to
    // 2.2199999999999998 in IEEE-754. Asserting the unrounded expression would
    // make this test fail for a value that is in fact correct.
    expect(computeParcelWeightOz({ preset: MAILER, items: [{ quantity: 4 }] })).toBe(
      Math.round((1.5 + DEFAULT_UNIT_WEIGHT_OZ * 4) * 100) / 100,
    );
  });

  it("lets an order-level override replace the whole total, packaging included", () => {
    const weight = computeParcelWeightOz({
      preset: MAILER,
      items: [{ productWeightOz: 2, quantity: 10 }],
      overrideOz: 12,
    });
    // Not 1.5 + 20 — the owner weighed the packed box and that number wins.
    expect(weight).toBe(12);
  });

  it("accepts an override typed into an admin form as a string", () => {
    expect(computeParcelWeightOz({ preset: MAILER, items: [{ quantity: 1 }], overrideOz: "9.25" })).toBe(9.25);
  });

  it("ignores an override that is zero, negative or unparseable", () => {
    const computed = 1.5 + 2;
    for (const bad of [0, -5, "", "   ", "abc", null, undefined, Number.NaN]) {
      expect(
        computeParcelWeightOz({ preset: MAILER, items: [{ productWeightOz: 2, quantity: 1 }], overrideOz: bad }),
      ).toBe(computed);
    }
  });

  it("ignores lines with a zero, negative or missing quantity", () => {
    expect(
      computeParcelWeightOz({
        preset: MAILER,
        items: [
          { productWeightOz: 2, quantity: 0 },
          { productWeightOz: 2, quantity: -3 },
          { productWeightOz: 2 },
          { productWeightOz: 2, quantity: "not a number" },
          { productWeightOz: 2, quantity: 1 },
        ],
      }),
    ).toBe(1.5 + 2);
  });

  it("counts whole units only for a fractional quantity", () => {
    expect(computeParcelWeightOz({ preset: MAILER, items: [{ productWeightOz: 2, quantity: 2.9 }] })).toBe(1.5 + 4);
  });

  it("handles an empty, null or missing item list", () => {
    expect(computeParcelWeightOz({ preset: MAILER, items: [] })).toBe(1.5);
    expect(computeParcelWeightOz({ preset: MAILER, items: null })).toBe(1.5);
    expect(computeParcelWeightOz({ preset: MAILER })).toBe(1.5);
  });

  it("clamps to the Shippo minimum instead of declaring a zero-weight parcel", () => {
    // Shippo rejects weight <= 0 outright, which would block the label.
    const emptyPreset = { ...MAILER, emptyWeightOz: 0 };
    expect(computeParcelWeightOz({ preset: emptyPreset, items: [] })).toBe(MIN_PARCEL_WEIGHT_OZ);
    expect(computeParcelWeightOz({ preset: emptyPreset, items: [{ productWeightOz: 2, quantity: 0 }] })).toBe(
      MIN_PARCEL_WEIGHT_OZ,
    );
  });

  it("does not clamp a real weight that is already above the minimum", () => {
    expect(computeParcelWeightOz({ preset: { ...MAILER, emptyWeightOz: 0 }, items: [{ productWeightOz: 0.25, quantity: 1 }] })).toBe(
      0.25,
    );
  });

  it("falls back to the standard mailer when no preset is available", () => {
    // A missing preset row must never block a label — the owner packs in this
    // mailer regardless.
    expect(computeParcelWeightOz({ items: [{ productWeightOz: 2, quantity: 1 }] })).toBe(
      FALLBACK_PACKAGE_PRESET.emptyWeightOz + 2,
    );
    expect(computeParcelWeightOz({ preset: null, items: [{ productWeightOz: 2, quantity: 1 }] })).toBe(
      FALLBACK_PACKAGE_PRESET.emptyWeightOz + 2,
    );
  });

  it("accepts a raw shipping_package_presets row in snake_case", () => {
    expect(
      computeParcelWeightOz({
        preset: { length_in: "9", width_in: "6", height_in: "3", empty_weight_oz: "2.5" },
        items: [{ product_shipping_weight_oz: "2", quantity: "2" }],
      }),
    ).toBe(2.5 + 4);
  });

  it("keeps float noise out of the declared weight", () => {
    // 0.1 * 3 is 0.30000000000000004 in binary floating point; 0.7 + that is
    // 1.0000000000000002, which would reach Shippo verbatim.
    expect(
      computeParcelWeightOz({
        preset: { ...MAILER, emptyWeightOz: 0.7 },
        items: [{ productWeightOz: 0.1, quantity: 3 }],
      }),
    ).toBe(1);
  });

  it("scales to a large multi-line order", () => {
    expect(
      computeParcelWeightOz({
        preset: MAILER,
        items: [
          { doseWeightOz: 1.25, quantity: 4 },
          { productWeightOz: 3, quantity: 2 },
          { quantity: 5 },
          { doseWeightOz: null, product_shipping_weight_oz: 0.5, quantity: 10 },
        ],
      }),
    ).toBe(1.5 + 5 + 6 + DEFAULT_UNIT_WEIGHT_OZ * 5 + 5);
  });
});

describe("resolvePackagePreset", () => {
  it("keeps a legitimate zero packaging weight", () => {
    expect(resolvePackagePreset({ ...MAILER, emptyWeightOz: 0 }).emptyWeightOz).toBe(0);
  });

  it("replaces missing or nonsense fields one at a time", () => {
    const preset = resolvePackagePreset({ lengthIn: 12, widthIn: 0, heightIn: null, emptyWeightOz: -4 });
    expect(preset).toEqual({
      lengthIn: 12,
      widthIn: FALLBACK_PACKAGE_PRESET.widthIn,
      heightIn: FALLBACK_PACKAGE_PRESET.heightIn,
      emptyWeightOz: FALLBACK_PACKAGE_PRESET.emptyWeightOz,
    });
  });

  it("falls back entirely when there is no preset at all", () => {
    expect(resolvePackagePreset(null)).toEqual(FALLBACK_PACKAGE_PRESET);
    expect(resolvePackagePreset(undefined)).toEqual(FALLBACK_PACKAGE_PRESET);
  });
});

describe("buildParcel", () => {
  it("builds the Shippo wire shape from the preset and the computed weight", () => {
    expect(
      buildParcel({ preset: MAILER, items: [{ productWeightOz: 2, quantity: 2 }] }),
    ).toEqual({
      length: "9",
      width: "6",
      height: "3",
      distance_unit: "in",
      weight: "5.5",
      mass_unit: "oz",
    });
  });

  it("uses the standard mailer's dimensions when no preset is available", () => {
    const parcel = buildParcel({ items: [{ quantity: 1 }] });
    expect(parcel.length).toBe("9");
    expect(parcel.width).toBe("6");
    expect(parcel.height).toBe("3");
  });

  it("carries the override into the declared weight", () => {
    expect(buildParcel({ preset: MAILER, items: [{ quantity: 10 }], overrideOz: 14.5 }).weight).toBe("14.5");
  });

  it("carries the minimum-weight clamp into the declared weight", () => {
    expect(buildParcel({ preset: { ...MAILER, emptyWeightOz: 0 }, items: [] }).weight).toBe("0.1");
  });

  it("formats decimals without trailing zeros or float noise", () => {
    const parcel = buildParcel({
      preset: { length_in: "10.50", width_in: "6.00", height_in: 3, empty_weight_oz: 0.7 },
      items: [{ productWeightOz: 0.1, quantity: 3 }],
    });
    expect(parcel.length).toBe("10.5");
    expect(parcel.width).toBe("6");
    expect(parcel.weight).toBe("1");
  });

  it("always declares inches and ounces", () => {
    const parcel = buildParcel({ preset: MAILER, items: [{ quantity: 1 }] });
    expect(parcel.distance_unit).toBe("in");
    expect(parcel.mass_unit).toBe("oz");
  });
});

// parseAmountToCents lives with the Shippo client (it parses that API's money
// format) but it is pure, and it is the single point where "shipping cost is
// never $0" is won or lost — so it is pinned here with the rest of the pure math.
describe("parseAmountToCents", () => {
  it("converts a Shippo amount string to integer cents", () => {
    expect(parseAmountToCents("5.20")).toBe(520);
    expect(parseAmountToCents("0.99")).toBe(99);
    expect(parseAmountToCents("12")).toBe(1200);
    expect(parseAmountToCents("12.5")).toBe(1250);
    expect(parseAmountToCents("103.47")).toBe(10347);
  });

  it("does not lose a cent to binary floating point", () => {
    // Number("1.15") * 100 is 114.99999999999999 — truncating that anywhere
    // downstream records 114 and under-reports every label's cost.
    expect(parseAmountToCents("1.15")).toBe(115);
    expect(parseAmountToCents("8.29")).toBe(829);
    expect(parseAmountToCents("1.005")).toBe(101);
  });

  it("rounds a third decimal rather than dropping it", () => {
    expect(parseAmountToCents("5.999")).toBe(600);
    expect(parseAmountToCents("5.204")).toBe(520);
    expect(parseAmountToCents("5.205")).toBe(521);
  });

  it("accepts a number by way of its exact decimal string", () => {
    expect(parseAmountToCents(5.2)).toBe(520);
    expect(parseAmountToCents(1.15)).toBe(115);
    expect(parseAmountToCents(7)).toBe(700);
  });

  it("returns null — never 0 — for anything unusable", () => {
    // 0 is a real price. Collapsing "unreadable" into 0 is exactly how a $0.00
    // postage cost gets written to an order.
    for (const bad of ["", "   ", "abc", "$5.20", "5,20", "-1.00", "1e3", null, undefined, Number.NaN, Infinity]) {
      expect(parseAmountToCents(bad)).toBeNull();
    }
  });

  it("parses a genuine zero as zero so the caller can reject it deliberately", () => {
    expect(parseAmountToCents("0.00")).toBe(0);
    expect(parseAmountToCents("0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE LIQUID GUARDRAIL.
//
// The defect this closes: a 10 mL liquid vial with no measured weight on file
// fell through to DEFAULT_UNIT_WEIGHT_OZ, which is documented in parcel.ts as
// "a 3ml peptide vial at 10 g". A 10 mL vial holds ten grams of FLUID on its
// own, before the glass — so the parcel was declared at roughly the weight of
// the empty container. Under-declaring is exactly the direction that earns a
// carrier adjustment.
//
// The guardrail invents no measurement. It composes the existing dry-vial
// constant (the container) with water density (the contents), which is a lower
// bound because an aqueous solution is water plus solute.
// ---------------------------------------------------------------------------
describe("liquid weight guardrail", () => {
  it("rates an unweighed liquid above the dry-vial default", () => {
    // THE DEFECT, stated as the assertion that used to fail.
    const tenMl = lineWeightOz({ doseLabel: "10mL" });
    expect(tenMl).toBeGreaterThan(DEFAULT_UNIT_WEIGHT_OZ);
    // vial + 10 g of fluid
    expect(tenMl).toBe(liquidFallbackWeightOz(10));
    expect(tenMl).toBe(0.72);
  });

  it("never lets an unweighed liquid declare less than the fluid it contains", () => {
    for (const ml of [1, 2, 5, 10, 30, 50, 100]) {
      const declared = lineWeightOz({ doseLabel: `${ml}mL` });
      expect(declared).toBeGreaterThan(gramsToOz(ml * LIQUID_DENSITY_G_PER_ML));
    }
  });

  it("lets a STORED weight win over the guardrail, in both directions", () => {
    // A measured value is the truth even when it is lighter than the estimate.
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 0.5 })).toBe(0.5);
    expect(lineWeightOz({ doseLabel: "10mL", productWeightOz: 0.61 })).toBe(0.61);
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 2 })).toBe(2);
  });

  it("treats a zero or negative stored weight as missing and still guards the liquid", () => {
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 0 })).toBe(0.72);
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: -1 })).toBe(0.72);
  });

  it("does NOT push a dry product onto the liquid path", () => {
    for (const label of ["5mg", "10mg", "24iu", "500mcg", "2 capsules", "", "10 units"]) {
      expect(lineWeightOz({ doseLabel: label })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    }
  });

  it("leaves every pre-existing case untouched when no label is present", () => {
    expect(lineWeightOz({})).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz(null)).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz({ doseLabel: null })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(lineWeightOz({ doseLabel: 10 })).toBe(DEFAULT_UNIT_WEIGHT_OZ);
  });

  it("accepts the snake_case alias a raw row carries", () => {
    expect(lineWeightOz({ dose_label: "10mL" })).toBe(0.72);
    expect(lineWeightOz({ dose_label: "30 ml" })).toBe(liquidFallbackWeightOz(30));
  });

  it("parses the volume forms the catalogue actually uses", () => {
    expect(parseDoseVolumeMl("10mL")).toBe(10);
    expect(parseDoseVolumeMl("10 mL")).toBe(10);
    expect(parseDoseVolumeMl("2ml")).toBe(2);
    expect(parseDoseVolumeMl("0.5 mL")).toBe(0.5);
    expect(parseDoseVolumeMl("30mL vial")).toBe(30);
    // and the ones it must refuse
    expect(parseDoseVolumeMl("5mg")).toBeNull();
    expect(parseDoseVolumeMl("500mcg")).toBeNull();
    expect(parseDoseVolumeMl("24iu")).toBeNull();
    expect(parseDoseVolumeMl("mL")).toBeNull();
    expect(parseDoseVolumeMl("0mL")).toBeNull();
    expect(parseDoseVolumeMl(null)).toBeNull();
    expect(parseDoseVolumeMl(12)).toBeNull();
  });

  it("still adds the tare exactly once across a mixed dry/liquid parcel", () => {
    const total = computeParcelWeightOz({
      preset: MAILER,
      items: [
        { doseLabel: "10mL", quantity: 2 },   // 0.72 x 2 = 1.44
        { doseWeightOz: 0.4, quantity: 3 },   // 0.40 x 3 = 1.20
        { doseLabel: "5mg", quantity: 1 },    // 0.36 x 1 = 0.36
      ],
    });
    expect(total).toBe(1.5 + 1.44 + 1.2 + 0.36);
  });

  it("reports a guardrailed line as an ESTIMATE, not a stored measurement", () => {
    expect(hasStoredWeight({ doseLabel: "10mL" })).toBe(false);
    expect(hasStoredWeight({ doseLabel: "10mL", doseWeightOz: 0 })).toBe(false);
    expect(hasStoredWeight({ doseWeightOz: 0.7 })).toBe(true);
    expect(hasStoredWeight({ productWeightOz: 0.7 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE PHYSICALLY-IMPOSSIBLE STORED WEIGHT.
//
// The guardrail above only helps a line with NO weight on file. The live defect
// is worse than that: a past catalogue-wide backfill wrote the dry-vial figure
// (0.36 oz) onto every product row, INCLUDING the 10 mL liquids. So B12 and
// LIPO-C do not fall through to a default at all — they carry a stored 0.36,
// and a stored value normally wins.
//
// 0.36 oz is exactly gramsToOz(10) — the mass of 10 mL of water and nothing
// else. A 10 mL vial cannot weigh that, because the glass is not weightless.
// The value is therefore not a measurement, and treating it as one is what
// under-declares the parcel.
//
// Only IMPOSSIBLE values are overridden. The catalogue's real measurements
// (bacteriostatic water 10 mL at 1.06 oz, 30 mL at 2.30 oz) sit well above
// their fluid floors and must pass through untouched.
// ---------------------------------------------------------------------------
describe("physically impossible stored liquid weight", () => {
  it("refuses a 10mL liquid stored at the mass of its own contents", () => {
    // THE LIVE DEFECT: B12 / LIPO-C as the catalogue actually holds them.
    expect(lineWeightOz({ doseLabel: "10mL", productWeightOz: 0.36 })).toBe(0.72);
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 0.36 })).toBe(0.72);
  });

  it("leaves a REAL measurement alone, including bac water at both volumes", () => {
    // These are the values on file today and must not move.
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 1.06 })).toBe(1.06);
    expect(lineWeightOz({ doseLabel: "30mL", doseWeightOz: 2.3 })).toBe(2.3);
  });

  it("uses the fluid mass as the floor, not an arbitrary threshold", () => {
    // 30 mL of water is 1.06 oz. Anything at or below that is impossible for a
    // 30 mL vial; the first hundredth above it is allowed through.
    expect(gramsToOz(30 * LIQUID_DENSITY_G_PER_ML)).toBe(1.06);
    expect(lineWeightOz({ doseLabel: "30mL", doseWeightOz: 1.06 })).toBe(liquidFallbackWeightOz(30));
    expect(lineWeightOz({ doseLabel: "30mL", doseWeightOz: 1.07 })).toBe(1.07);
  });

  it("never overrides a DRY product's stored weight, however small", () => {
    // A 5mg dry vial legitimately weighs very little. No liquid floor applies.
    expect(lineWeightOz({ doseLabel: "5mg", productWeightOz: 0.36 })).toBe(0.36);
    expect(lineWeightOz({ doseLabel: "10mg", doseWeightOz: 0.1 })).toBe(0.1);
    expect(lineWeightOz({ productWeightOz: 0.36 })).toBe(0.36);
  });

  it("keeps dose precedence over product when both are plausible", () => {
    expect(lineWeightOz({ doseLabel: "10mL", doseWeightOz: 1.2, productWeightOz: 0.36 })).toBe(1.2);
  });

  it("corrects the real catalogue parcel it was written for", () => {
    // 2 x B12 10mL as stored today, in the standard mailer (1.06 oz tare).
    const before = 1.06 + 0.36 * 2;   // 1.78 oz — what Shippo used to be told
    const after = computeParcelWeightOz({
      preset: { ...MAILER, emptyWeightOz: 1.06 },
      items: [{ doseLabel: "10mL", productWeightOz: 0.36, quantity: 2 }],
    });
    expect(after).toBe(1.06 + 0.72 * 2);
    expect(after).toBeGreaterThan(before);
  });
});
