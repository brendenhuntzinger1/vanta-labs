import { describe, expect, it } from "vitest";

import { tallyUnitsSoldByLineKey } from "@/lib/inventory-velocity";

// order_items.product_id is the `slug::doseId` composite the checkout writes
// (quote-order.ts splits it the same way). Inventory keys it as `dose:<id>`,
// or `product:<uuid>` for a product sold without doses.
const PRODUCT_ID_BY_SLUG = { "bacteriostatic-water": "prod-uuid-1" };

describe("tallyUnitsSoldByLineKey", () => {
  it("credits a dose composite to that dose's inventory line", () => {
    const result = tallyUnitsSoldByLineKey(
      [{ product_id: "glp-3::dose-abc", quantity: 2 }],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({ "dose:dose-abc": 2 });
  });

  it("adds up every order line for the same dose", () => {
    const result = tallyUnitsSoldByLineKey(
      [
        { product_id: "glp-3::dose-abc", quantity: 2 },
        { product_id: "glp-3::dose-abc", quantity: 3 },
      ],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({ "dose:dose-abc": 5 });
  });

  it("resolves a dose-less slug to its product line", () => {
    const result = tallyUnitsSoldByLineKey(
      [{ product_id: "bacteriostatic-water", quantity: 4 }],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({ "product:prod-uuid-1": 4 });
  });

  it("skips a slug that no longer exists in the catalogue", () => {
    const result = tallyUnitsSoldByLineKey(
      [{ product_id: "deleted-product", quantity: 4 }],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({});
  });

  it("ignores a line with no product reference at all", () => {
    const result = tallyUnitsSoldByLineKey(
      [{ product_id: null, quantity: 4 }, { product_id: "", quantity: 4 }],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({});
  });

  it("ignores an unusable quantity rather than tallying NaN", () => {
    const result = tallyUnitsSoldByLineKey(
      [
        { product_id: "glp-3::dose-abc", quantity: Number.NaN },
        { product_id: "glp-3::dose-abc", quantity: -5 },
        { product_id: "glp-3::dose-abc", quantity: 3 },
      ],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({ "dose:dose-abc": 3 });
  });

  it("keeps separate doses of one product apart", () => {
    const result = tallyUnitsSoldByLineKey(
      [
        { product_id: "glp-3::dose-30mg", quantity: 1 },
        { product_id: "glp-3::dose-5mg", quantity: 7 },
      ],
      PRODUCT_ID_BY_SLUG,
    );

    expect(result).toEqual({ "dose:dose-30mg": 1, "dose:dose-5mg": 7 });
  });

  it("returns nothing for no orders", () => {
    expect(tallyUnitsSoldByLineKey([], PRODUCT_ID_BY_SLUG)).toEqual({});
  });
});
