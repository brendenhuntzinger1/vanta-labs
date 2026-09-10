import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: { from: () => ({}) } }));

import { stockValuesForWrite, type DoseInput } from "@/lib/admin-products";

// ---------------------------------------------------------------------------
// AN ORDINARY PRODUCT SAVE MUST NOT REVERT A SALE.
//
// The Admin → Products form shows an Inventory box and posts it back with
// everything else, and editableDoseValues wrote it unconditionally. So renaming
// a dose, fixing a typo in a description, or pasting a COA URL re-asserted
// whatever stock count the page had loaded — silently reverting every order
// that had landed while the form was open.
//
// It corrupts the authoritative shelf count in BOTH directions and neither is
// visible. Over-count oversells: reserve_inventory happily holds units that do
// not exist, the customer is charged, and finalize clamps at 0 without erroring,
// so the store has taken money for stock it does not have. Under-count hides
// real inventory and stops it being sold.
//
// The fix is not to drop the field — the form legitimately offers it, and a box
// that silently discards what an admin types is the same class of bug pointing
// the other way. Instead the save now carries the value the editor LOADED, and:
//
//   unchanged -> stock is not written at all, so a concurrent sale survives
//   changed   -> stock is written as a compare-and-set against that value, so a
//                sale landing mid-edit is refused loudly instead of overwritten
//
// A dose being INSERTED has no existing stock to lose, so its submitted number
// is always written.
// ---------------------------------------------------------------------------

const dose = (over: Partial<DoseInput> = {}): DoseInput => ({
  id: "dose-1",
  label: "10mg",
  slugSuffix: "10mg",
  priceCents: 5900,
  inventoryQuantity: 12,
  ...over,
});

describe("stock is written only when the admin actually changed it", () => {
  it("writes nothing when the submitted count matches what the editor loaded", () => {
    // The whole defect: an unrelated edit, stock untouched.
    expect(stockValuesForWrite(dose({ inventoryQuantity: 12, inventoryQuantityAtLoad: 12 }), "update")).toEqual({});
  });

  it("writes the new count when the admin changed it", () => {
    const values = stockValuesForWrite(dose({ inventoryQuantity: 40, inventoryQuantityAtLoad: 12 }), "update");
    expect(values.inventory_quantity).toBe(40);
    expect(values.stock_status).toBeDefined();
  });

  it("writes a deliberate reduction to zero", () => {
    // Distinct from "field left alone at zero" only by the baseline, which is
    // exactly why the baseline has to travel with the save.
    const values = stockValuesForWrite(dose({ inventoryQuantity: 0, inventoryQuantityAtLoad: 12 }), "update");
    expect(values.inventory_quantity).toBe(0);
  });

  it("writes nothing on an update from a client that sent no baseline", () => {
    // The safe direction: an older client loses the ability to set stock from
    // this form rather than silently corrupting it.
    expect(stockValuesForWrite(dose({ inventoryQuantity: 99 }), "update")).toEqual({});
  });

  it("always writes stock for a brand new dose, baseline or not", () => {
    expect(stockValuesForWrite(dose({ inventoryQuantity: 25 }), "insert").inventory_quantity).toBe(25);
    expect(
      stockValuesForWrite(dose({ inventoryQuantity: 25, inventoryQuantityAtLoad: 25 }), "insert").inventory_quantity,
    ).toBe(25);
  });

  it("normalises a negative or fractional submission rather than storing it", () => {
    expect(stockValuesForWrite(dose({ inventoryQuantity: -5, inventoryQuantityAtLoad: 10 }), "update").inventory_quantity).toBe(0);
    expect(stockValuesForWrite(dose({ inventoryQuantity: 7.6, inventoryQuantityAtLoad: 10 }), "update").inventory_quantity).toBe(8);
  });

  it("treats a baseline that differs only by rounding as unchanged", () => {
    expect(stockValuesForWrite(dose({ inventoryQuantity: 12.4, inventoryQuantityAtLoad: 12 }), "update")).toEqual({});
  });
});
