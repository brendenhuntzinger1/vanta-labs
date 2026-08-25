import { describe, expect, it } from "vitest";

import { effectiveUnitPriceCents, findProductsPricedBelowCost } from "@/lib/system-status";

/**
 * The launch-status screen had a blind spot that production walked into.
 *
 * "Published products have a price" passed (Bac Water had one: $2.00) and
 * "Published products have a unit cost (COGS)" passed (it had one: $8.00), so
 * the owner's status screen was all green while the profit guard refused every
 * cart containing that product — in the card lane and the wallet lane alike.
 * It is the relationship between the two numbers that was wrong.
 */
describe("findProductsPricedBelowCost", () => {
  const row = (over: Partial<{ price_cents: number | null; sale_price_cents: number | null; product_cost_cents: number | null }> = {}) => ({
    name: "Test product",
    price_cents: 5000,
    sale_price_cents: null as number | null,
    product_cost_cents: 1000,
    ...over,
  });

  it("flags the real production row: Bac Water sold at $2.00 against an $8.00 cost", () => {
    const bacWater = row({ price_cents: 200, product_cost_cents: 800 });
    expect(findProductsPricedBelowCost([bacWater])).toEqual([bacWater]);
  });

  it("leaves a healthy margin alone", () => {
    expect(findProductsPricedBelowCost([row()])).toEqual([]);
  });

  it("flags a price exactly equal to cost — zero margin still loses money once fees and shipping land", () => {
    expect(findProductsPricedBelowCost([row({ price_cents: 1000, product_cost_cents: 1000 })])).toHaveLength(1);
  });

  it("judges a discounted product on the price actually charged, not the list price", () => {
    // Lists above cost, but the sale price is under it — this is what the
    // shopper pays, so it is what the guard prices.
    expect(findProductsPricedBelowCost([row({ price_cents: 5000, sale_price_cents: 900, product_cost_cents: 1000 })])).toHaveLength(1);
    expect(findProductsPricedBelowCost([row({ price_cents: 5000, sale_price_cents: 4000, product_cost_cents: 1000 })])).toEqual([]);
  });

  it("does not cry wolf on a product with no cost on file", () => {
    // An unknown cost is the "no COGS" check's business. Treating a missing
    // cost as below-cost would flag every product awaiting a cost import.
    expect(findProductsPricedBelowCost([row({ product_cost_cents: 0 })])).toEqual([]);
    expect(findProductsPricedBelowCost([row({ product_cost_cents: null })])).toEqual([]);
  });

  it("does not flag an unpriced product — that is the price check's job", () => {
    expect(findProductsPricedBelowCost([row({ price_cents: 0, product_cost_cents: 800 })])).toEqual([]);
  });
});

describe("effectiveUnitPriceCents", () => {
  it("prefers a real sale price and ignores a zeroed one", () => {
    expect(effectiveUnitPriceCents({ price_cents: 5000, sale_price_cents: 3000 })).toBe(3000);
    expect(effectiveUnitPriceCents({ price_cents: 5000, sale_price_cents: 0 })).toBe(5000);
    expect(effectiveUnitPriceCents({ price_cents: 5000, sale_price_cents: null })).toBe(5000);
  });
});
