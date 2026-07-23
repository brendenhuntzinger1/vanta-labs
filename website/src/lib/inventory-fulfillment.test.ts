import { describe, expect, it } from "vitest";
import { parseOrderItemRef, planInventoryAdjustments } from "./inventory-fulfillment";

describe("parseOrderItemRef", () => {
  it("splits a bare slug into slug + no variant", () => {
    expect(parseOrderItemRef("bpc-157-10mg")).toEqual({ slug: "bpc-157-10mg", variantId: null });
  });

  it("splits slug::variant into both parts", () => {
    expect(parseOrderItemRef("bpc-157-10mg::dose-uuid-1")).toEqual({
      slug: "bpc-157-10mg",
      variantId: "dose-uuid-1",
    });
  });

  it("treats an empty variant suffix as no variant", () => {
    expect(parseOrderItemRef("bpc-157-10mg::")).toEqual({ slug: "bpc-157-10mg", variantId: null });
  });
});

describe("planInventoryAdjustments", () => {
  it("maps each line to a positive quantity per product", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg", quantity: 2 },
      { productId: "tb-500::dose-a", quantity: 1 },
    ]);
    expect(plan).toEqual([
      { slug: "bpc-157-10mg", variantId: null, quantity: 2 },
      { slug: "tb-500", variantId: "dose-a", quantity: 1 },
    ]);
  });

  it("sums duplicate lines for the same product/variant into one adjustment", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg", quantity: 2 },
      { productId: "bpc-157-10mg", quantity: 3 },
    ]);
    expect(plan).toEqual([{ slug: "bpc-157-10mg", variantId: null, quantity: 5 }]);
  });

  it("keeps the same slug's distinct variants separate", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg::dose-a", quantity: 1 },
      { productId: "bpc-157-10mg::dose-b", quantity: 1 },
      { productId: "bpc-157-10mg", quantity: 1 },
    ]);
    expect(plan).toHaveLength(3);
  });

  it("drops lines with no product id or a non-positive quantity, truncating fractional counts", () => {
    const plan = planInventoryAdjustments([
      { productId: "", quantity: 5 },
      { productId: null, quantity: 5 },
      { productId: "x", quantity: 0 },
      { productId: "y", quantity: -3 },
      { productId: "z", quantity: 2.5 },
      { productId: "ok", quantity: 4 },
    ]);
    // 2.5 truncates to 2 (a real, shippable count); the rest are dropped.
    expect(plan).toEqual([
      { slug: "z", variantId: null, quantity: 2 },
      { slug: "ok", variantId: null, quantity: 4 },
    ]);
  });

  it("handles an empty or missing list", () => {
    expect(planInventoryAdjustments([])).toEqual([]);
    // @ts-expect-error — defensive against a nullish payload at runtime.
    expect(planInventoryAdjustments(undefined)).toEqual([]);
  });
});
