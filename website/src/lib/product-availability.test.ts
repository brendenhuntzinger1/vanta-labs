import { describe, expect, it } from "vitest";

import { resolveHeadlineAvailability, type AvailabilityInput } from "@/lib/product-availability";

// ---------------------------------------------------------------------------
// THE ONE RULE FOR "HOW MANY CAN SOMEONE BUY".
//
// This exists because getting it wrong is the single most repeated mistake
// against this database, and the mistake always looks like a real finding.
//
// Twice now an audit has reported that most of the catalogue is sold out, both
// times by reading products.inventory_quantity:
//
//   select count(*) from products
//    where is_published and track_inventory and coalesce(inventory_quantity,0) <= 0;
//
// The first pass called it "17 of 38 sold out"; the true figure was 2. The
// second called it "30 products advertising In Stock with zero on hand"; the
// true figure was 0. For a product sold through doses the parent row is NOT the
// shelf — 86% of the live catalogue carries parent 0 with stock on its doses,
// and that is the correct, normal shape.
//
// catalog.ts has always applied the right rule. src/lib/sql/canonical-availability.sql
// documents it in SQL. This is the same rule as a tested function, so any new
// surface reaches for it instead of re-deriving it and getting it wrong again.
//
//   product HAS an enabled dose  -> the DEFAULT dose's count is the shelf
//   product has NO enabled dose  -> the parent row's count is the shelf
//
// Default dose = enabled, ordered by (isDefault desc, position asc).
// Available = on-hand MINUS reserved, floored at zero.
// ---------------------------------------------------------------------------

const product = (over: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  inventoryQuantity: 0,
  reservedQuantity: 0,
  doses: [],
  ...over,
});

describe("resolveHeadlineAvailability — undosed products", () => {
  it("uses the parent row when there are no doses at all", () => {
    const result = resolveHeadlineAvailability(product({ inventoryQuantity: 12 }));
    expect(result).toEqual({ available: 12, allVariants: 12, soldViaDoses: false, hidesSellableVariants: false });
  });

  it("subtracts reserved units from the parent shelf", () => {
    expect(resolveHeadlineAvailability(product({ inventoryQuantity: 10, reservedQuantity: 4 })).available).toBe(6);
  });

  it("never returns a negative shelf when reservations exceed stock", () => {
    expect(resolveHeadlineAvailability(product({ inventoryQuantity: 2, reservedQuantity: 9 })).available).toBe(0);
  });
});

describe("resolveHeadlineAvailability — the dosed shape that keeps being misread", () => {
  it("reads the default dose, NOT the parent, when doses exist", () => {
    // THE REGRESSION THAT MATTERS. Parent says zero; the product is fully in
    // stock. Reading the parent here is what produced both false audits.
    const result = resolveHeadlineAvailability(
      product({
        inventoryQuantity: 0,
        doses: [
          { inventoryQuantity: 29, reservedQuantity: 0, isDefault: true, isEnabled: true, position: 0 },
          { inventoryQuantity: 29, reservedQuantity: 0, isDefault: false, isEnabled: true, position: 1 },
        ],
      }),
    );

    expect(result.available).toBe(29);
    expect(result.allVariants).toBe(58);
    expect(result.soldViaDoses).toBe(true);
  });

  it("falls back to position order when no dose is flagged default", () => {
    const result = resolveHeadlineAvailability(
      product({
        doses: [
          { inventoryQuantity: 5, reservedQuantity: 0, isDefault: false, isEnabled: true, position: 3 },
          { inventoryQuantity: 7, reservedQuantity: 0, isDefault: false, isEnabled: true, position: 1 },
        ],
      }),
    );

    expect(result.available).toBe(7);
  });

  it("ignores disabled doses when choosing the default and when totalling", () => {
    const result = resolveHeadlineAvailability(
      product({
        doses: [
          { inventoryQuantity: 99, reservedQuantity: 0, isDefault: true, isEnabled: false, position: 0 },
          { inventoryQuantity: 4, reservedQuantity: 0, isDefault: false, isEnabled: true, position: 1 },
        ],
      }),
    );

    expect(result.available).toBe(4);
    expect(result.allVariants).toBe(4);
  });

  it("falls back to the parent when every dose is disabled", () => {
    const result = resolveHeadlineAvailability(
      product({
        inventoryQuantity: 6,
        doses: [{ inventoryQuantity: 99, reservedQuantity: 0, isDefault: true, isEnabled: false, position: 0 }],
      }),
    );

    expect(result.available).toBe(6);
    expect(result.soldViaDoses).toBe(false);
  });

  it("subtracts reservations on the default dose", () => {
    const result = resolveHeadlineAvailability(
      product({
        doses: [{ inventoryQuantity: 10, reservedQuantity: 3, isDefault: true, isEnabled: true, position: 0 }],
      }),
    );

    expect(result.available).toBe(7);
  });

  it("flags a headline of zero while other variants still have stock", () => {
    // The one genuinely bad shape: the card would read Out of Stock while
    // sellable units sit behind it on another dose.
    const result = resolveHeadlineAvailability(
      product({
        doses: [
          { inventoryQuantity: 0, reservedQuantity: 0, isDefault: true, isEnabled: true, position: 0 },
          { inventoryQuantity: 12, reservedQuantity: 0, isDefault: false, isEnabled: true, position: 1 },
        ],
      }),
    );

    expect(result.available).toBe(0);
    expect(result.allVariants).toBe(12);
    expect(result.hidesSellableVariants).toBe(true);
  });

  it("does not flag hidden variants when the headline itself has stock", () => {
    const result = resolveHeadlineAvailability(
      product({ doses: [{ inventoryQuantity: 3, reservedQuantity: 0, isDefault: true, isEnabled: true, position: 0 }] }),
    );

    expect(result.hidesSellableVariants).toBe(false);
  });
});

describe("resolveHeadlineAvailability — hostile input", () => {
  it("treats missing and non-numeric counts as zero rather than NaN", () => {
    const result = resolveHeadlineAvailability({
      inventoryQuantity: undefined,
      reservedQuantity: undefined,
      doses: [{ inventoryQuantity: undefined, reservedQuantity: undefined, isEnabled: true }],
    } as unknown as AvailabilityInput);

    expect(result.available).toBe(0);
    expect(Number.isNaN(result.available)).toBe(false);
  });

  it("treats a missing dose list as an undosed product", () => {
    const result = resolveHeadlineAvailability({ inventoryQuantity: 5 } as unknown as AvailabilityInput);
    expect(result).toEqual({ available: 5, allVariants: 5, soldViaDoses: false, hidesSellableVariants: false });
  });
});
