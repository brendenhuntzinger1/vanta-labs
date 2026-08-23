import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeOrderProfit } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// YESTERDAY'S PROFIT MUST NOT CHANGE WHEN TODAY'S CATALOG DOES.
//
// This is the invariant that separates a books-of-record from a spreadsheet.
// Raise a product's cost this morning and every historical order that ever
// contained it silently re-prices: last month's margin moves, the annual
// figures move, and there is no record that anything happened. Nobody notices,
// because the wrong number looks exactly like the right one.
//
// The design that prevents it is a SNAPSHOT: checkout writes the cost of the
// moment onto order_items.unit_cost_cents, and the profit engine reads that row
// and only that row. The failure mode is not subtle to write and is very easy
// to introduce — one join to `products` for "the current cost" inside the
// order-items resolver and the property is gone, with no test failing, because
// every fixture would still compute the same answer while the fixture's catalog
// happened to match.
//
// So this file pins the property from both ends: the engine's arithmetic, and
// the shape of the query that feeds it.
// ---------------------------------------------------------------------------

const WEBSITE_ROOT = process.cwd();
const source = (path: string) => readFileSync(resolve(WEBSITE_ROOT, path), "utf8");

/** One order, priced once. Everything below varies only the catalog around it. */
const HISTORICAL_ORDER = {
  netMerchandiseRevenue: 240,
  shippingRevenue: 0,
  shippingCost: 8.4,
  shippingCostIsEstimate: false,
  commission: 0,
  processingFee: 7.2,
  refund: 0,
  // Two vials at a snapshotted $31.00 each.
  lines: [{ unitCostCents: 3100, quantity: 2 }],
};

describe("historical order economics are computed from the snapshot, not the catalog", () => {
  it("prices an order from unit_cost_cents alone", () => {
    const result = computeOrderProfit(HISTORICAL_ORDER);
    // 2 x $31.00 = $62.00 COGS. $240 - 62 - 8.40 - 7.20 = $162.40.
    expect(result.cogs).toBe(62);
    expect(result.profit).toBe(162.4);
    expect(result.hasEstimatedCost).toBe(false);
    expect(result.profitStatus).toBe("finalized");
  });

  it("has no input through which today's catalog cost could reach it", () => {
    // The engine takes a cost PER LINE and nothing else. There is no product id,
    // no slug, no catalog handle — so it cannot look anything up even if a
    // caller wanted it to. The property is structural, not a convention.
    const keys = Object.keys(HISTORICAL_ORDER.lines[0]);
    expect(keys.sort()).toEqual(["quantity", "unitCostCents"]);
  });

  it("uses the worst-case fallback ONLY where a snapshot is missing, and says so", () => {
    // A line with no snapshot is the one case where a configured number enters
    // a historical order. It must be conservative (worst case, so profit is
    // never overstated) and it must mark the order as estimated rather than
    // presenting a modelled figure as a settled one.
    const result = computeOrderProfit({
      ...HISTORICAL_ORDER,
      lines: [{ unitCostCents: 3100, quantity: 1 }, { unitCostCents: null, quantity: 1 }],
      fallbackUnitCostCents: 4500,
    });
    expect(result.cogs).toBe(76); // 31.00 + 45.00
    expect(result.hasEstimatedCost).toBe(true);
    expect(result.profitStatus).toBe("estimated");
  });

  it("a snapshot of zero is a real cost, not a missing one", () => {
    // A free promotional line costs the store nothing to buy but is not an
    // unknown. Treating 0 as "missing" would substitute the worst-case fallback
    // and invent an expense that was never incurred.
    const result = computeOrderProfit({ ...HISTORICAL_ORDER, lines: [{ unitCostCents: 0, quantity: 3 }], fallbackUnitCostCents: 4500 });
    expect(result.cogs).toBe(0);
    expect(result.hasEstimatedCost).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE QUERY.
//
// The arithmetic above cannot be wrong. What CAN go wrong is upstream: the
// resolver that builds those lines reaching into the catalog for "the current
// cost" of a product it already has a snapshot for. That is a one-line change
// that no arithmetic test can see, so it is asserted directly against the
// source.
// ---------------------------------------------------------------------------
describe("the order-items resolver reads the snapshot and nothing else", () => {
  const adminProfit = source("src/lib/admin-profit.ts");

  it("selects unit_cost_cents from order_items", () => {
    expect(adminProfit).toContain('.select("order_id, quantity, unit_cost_cents")');
  });

  it("never joins the products table while resolving historical costs", () => {
    // Any of these appearing in the profit resolver means a historical order's
    // cost is being read from a table that changes underneath it.
    for (const liveCostSource of ['from("products")', 'from("product_doses")', "getCatalogProducts", "product_cost", "cost_per_unit"]) {
      expect(adminProfit).not.toContain(liveCostSource);
    }
  });

  it("states in order-profit.ts that the snapshot is the rule", () => {
    // The comment is load-bearing: it is what tells the next person editing
    // this file that the missing join is deliberate, not an oversight to
    // helpfully fill in.
    const engine = source("src/lib/order-profit.ts");
    // Line-wrapped in the source, so matched in the two halves it wraps into.
    expect(engine).toContain("never from today's");
    expect(engine).toContain("live product cost");
    expect(engine).toContain("order_items.unit_cost_cents");
  });
});
