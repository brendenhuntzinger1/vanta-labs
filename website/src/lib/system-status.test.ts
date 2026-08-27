import { describe, expect, it } from "vitest";

import {
  effectiveUnitPriceCents,
  findProductsMissingCost,
  findProductsPricedBelowCost,
  firstBelowCostUnit,
  type SellableUnit,
} from "@/lib/system-status";

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

// ---------------------------------------------------------------------------
// COST RESOLUTION MUST MIRROR quote-order.ts, OR BOTH CHECKS GO BLIND.
//
// Phase 2 Section 4 nulls products.product_cost_cents for all 38 published
// dose-bearing products, because that column holds inherited EvoLabs seed
// costs 1.4x-6.8x the true landed figure. resolveUnitCostCents already reads
// the DOSE cost and falls back to the parent only for a product with no dose
// rows at all. These checks read ONLY the parent column, so after Section 4:
//
//   product_cogs             warns on all 38 forever — pure noise.
//   product_sellable_margin  can NEVER fire again, because it requires
//                            cost > 0 and every parent cost is now NULL.
//
// The second one is blocksLaunch and is, in its own words, the only thing that
// catches a below-cost product. A check that cannot fire is worse than no
// check: the status screen reports it as passing.
// ---------------------------------------------------------------------------
describe("cost resolution falls back to the dose, as checkout does", () => {
  const dose = (over: Partial<SellableUnit> = {}): SellableUnit => ({
    price_cents: 5000,
    sale_price_cents: null,
    product_cost_cents: 1200,
    ...over,
  });
  // A dose-bearing product after Section 4: the parent cost is gone.
  const withDoses = (doses: SellableUnit[]) => ({
    name: "Dose-bearing product",
    price_cents: 5000,
    sale_price_cents: null as number | null,
    product_cost_cents: null as number | null,
    doses,
  });

  it("still finds a below-cost DOSE when the parent cost is NULL", () => {
    const product = withDoses([dose(), dose({ price_cents: 1000, product_cost_cents: 1400 })]);
    expect(findProductsPricedBelowCost([product])).toEqual([product]);
  });

  it("does not flag a dose-bearing product whose doses all price above their cost", () => {
    expect(findProductsPricedBelowCost([withDoses([dose(), dose({ price_cents: 9000, product_cost_cents: 2000 })])]))
      .toEqual([]);
  });

  it("measures a dose against its OWN price, never the parent's", () => {
    // The parent lists at $5.00 while the dose sells for $90 and costs $20.
    // Comparing the dose's cost to the parent's price would block launch on a
    // perfectly healthy product.
    const product = { ...withDoses([dose({ price_cents: 9000, product_cost_cents: 2000 })]), price_cents: 500 };
    expect(findProductsPricedBelowCost([product])).toEqual([]);
  });

  it("still uses the parent cost for a product with NO dose rows", () => {
    const doseless = { name: "Bac water", price_cents: 200, sale_price_cents: null, product_cost_cents: 800, doses: [] };
    expect(findProductsPricedBelowCost([doseless])).toEqual([doseless]);
  });

  it("reports the offending DOSE's own figures to the operator", () => {
    const product = withDoses([dose(), dose({ price_cents: 1000, product_cost_cents: 1400 })]);
    const unit = firstBelowCostUnit(product);
    expect(unit).toEqual({ price_cents: 1000, sale_price_cents: null, product_cost_cents: 1400 });
  });
});

describe("findProductsMissingCost", () => {
  const parent = (cost: number | null) => ({ price_cents: 5000, sale_price_cents: null, product_cost_cents: cost });

  it("does NOT warn on a dose-bearing product whose doses are costed, parent cost NULL", () => {
    // The exact state Phase 2 Section 4 leaves behind. Reading the parent
    // column alone warned here on all 38 products, every load, forever.
    expect(findProductsMissingCost([{
      ...parent(null),
      doses: [{ price_cents: 5000, sale_price_cents: null, product_cost_cents: 1200 }],
    }])).toEqual([]);
  });

  it("warns when a dose has no cost on file", () => {
    const product = {
      ...parent(null),
      doses: [
        { price_cents: 5000, sale_price_cents: null, product_cost_cents: 1200 },
        { price_cents: 9000, sale_price_cents: null, product_cost_cents: null },
      ],
    };
    expect(findProductsMissingCost([product])).toEqual([product]);
  });

  it("warns on a dose-less product with no parent cost, and not on one that has it", () => {
    expect(findProductsMissingCost([parent(null)])).toHaveLength(1);
    expect(findProductsMissingCost([parent(0)])).toHaveLength(1);
    expect(findProductsMissingCost([parent(800)])).toEqual([]);
  });
});
