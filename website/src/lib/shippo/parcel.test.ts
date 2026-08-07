import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIT_WEIGHT_OZ,
  FALLBACK_PACKAGE_PRESET,
  MIN_PARCEL_WEIGHT_OZ,
  buildParcel,
  computeParcelWeightOz,
  lineWeightOz,
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
