import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ZERO MEANS ZERO.
//
// With inventory tracking ON and a count of 0, the catalogue used to report
// "In Stock" and sell unlimited units. The old rule read 0 as "not tracked
// numerically" and deferred to the stored stock_status -- correct when a 3PL
// owned the stock and our counts were decorative, backwards once Vanta Labs
// fulfils its own orders.
//
// The audit found 35 products and 44 doses in exactly that state: shelf empty,
// listing live, no cap at checkout.
//
// The rule now: tracking ON + quantity <= 0  ->  Out of Stock.
//              tracking OFF                  ->  unchanged, everything sells.
// ---------------------------------------------------------------------------

const catalog = readFileSync(join(process.cwd(), "src/lib/catalog.ts"), "utf8");
const quote = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");

// resolveStockStatus is module-private, so this mirrors it exactly. The
// structural assertions below prove the real implementation matches.
function resolveStockStatus(rawStatus: string, inventoryActive: boolean, quantity?: number) {
  if (!inventoryActive) return "In Stock";
  if (typeof quantity === "number" && Number.isFinite(quantity) && quantity <= 0) return "Out of Stock";
  return rawStatus || "In Stock";
}

describe("tracking ON — an empty shelf reads as empty", () => {
  it("a stored 'In Stock' with 0 units resolves to Out of Stock", () => {
    expect(resolveStockStatus("In Stock", true, 0)).toBe("Out of Stock");
  });

  it("a negative count also resolves to Out of Stock", () => {
    expect(resolveStockStatus("In Stock", true, -3)).toBe("Out of Stock");
  });

  it("a real positive count keeps the stored status", () => {
    expect(resolveStockStatus("In Stock", true, 12)).toBe("In Stock");
  });

  it("an explicit Out of Stock stays out of stock at any count", () => {
    expect(resolveStockStatus("Out of Stock", true, 50)).toBe("Out of Stock");
  });

  // Reserved is a separate state checkout rejects on its own; the zero rule
  // must not quietly convert it into something else.
  it("leaves Reserved alone when stock exists", () => {
    expect(resolveStockStatus("Reserved", true, 5)).toBe("Reserved");
  });
});

describe("tracking OFF — nothing changes", () => {
  // The escape hatch. If this rule ever strands the catalogue, switching
  // tracking off restores the previous behaviour exactly.
  it("everything is In Stock regardless of count", () => {
    expect(resolveStockStatus("Out of Stock", false, 0)).toBe("In Stock");
    expect(resolveStockStatus("In Stock", false, 0)).toBe("In Stock");
    expect(resolveStockStatus("In Stock", false, -5)).toBe("In Stock");
  });
});

describe("an unknown count is not treated as empty", () => {
  // undefined means "no count supplied", which is not the same claim as zero.
  it("falls through to the stored status", () => {
    expect(resolveStockStatus("In Stock", true, undefined)).toBe("In Stock");
    expect(resolveStockStatus("In Stock", true, Number.NaN)).toBe("In Stock");
  });
});

describe("the real implementation matches", () => {
  it("resolveStockStatus takes the quantity", () => {
    expect(catalog).toContain("function resolveStockStatus(\n  rawStatus: string,\n  inventoryActive: boolean,\n  quantity?: number,\n)");
  });

  it("returns Out of Stock for a non-positive tracked count", () => {
    expect(catalog).toContain('if (typeof quantity === "number" && Number.isFinite(quantity) && quantity <= 0) {');
    expect(catalog).toContain('return "Out of Stock";');
  });

  it("checks tracking first, so an untracked catalogue can never be stranded", () => {
    const fn = catalog.slice(catalog.indexOf("function resolveStockStatus"));
    expect(fn.indexOf("if (!inventoryActive)")).toBeLessThan(fn.indexOf("quantity <= 0"));
  });

  // Both call sites must pass a count, or the products page and the PDP would
  // disagree with each other about the same item. The count is now AVAILABILITY
  // — stock on hand less what in-flight checkouts hold — because a unit someone
  // else is buying is not one this shopper can have.
  it("passes availability, not raw stock, at the dose call site", () => {
    expect(catalog).toContain('sellable(parseNumber(row.inventory_quantity, 0), reserved.byDoseId.get(String(row.id)) ?? 0),');
  });

  it("passes availability at the product call site when there is no dose", () => {
    expect(catalog).toContain("defaultDose ? defaultInventoryQuantity : sellable(defaultInventoryQuantity, reservedQuantity)");
  });

  it("subtracts reservations rather than clamping them away", () => {
    expect(catalog).toContain("Math.max(0, onHand - reserved)");
  });

  it("degrades to nothing-reserved rather than taking the shop down", () => {
    // The reserved lookup is deliberately separate from the catalogue queries:
    // those decide whether the storefront renders at all.
    const fn = catalog.slice(catalog.indexOf("async function fetchReservedQuantities"));
    expect(fn.slice(0, fn.indexOf("}\n\n"))).toContain("catch");
  });

  // Storefront and checkout must agree: a shopper should never add something
  // labelled In Stock and be refused at the last step.
  it("checkout still rejects an Out of Stock line", () => {
    expect(quote).toContain('if (product.stockStatus === "Out of Stock") {');
  });

  it("the positive-count cap is still enforced", () => {
    expect(quote).toContain("if (item.quantity > trackedInventory) {");
  });
});
