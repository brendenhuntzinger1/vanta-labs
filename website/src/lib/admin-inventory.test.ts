import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Inventory admin: packed weights and the enforcement guard.
//
// Two things here are load-bearing enough to be worth pinning down:
//
//   1. THE WEIGHT A LINE SHIPS AT. The admin screen shows the owner a number
//      and tells them it is what postage will be based on. If this module
//      resolves the dose/product/default chain differently from parcel.ts, the
//      screen is lying and the first anyone knows is a postage-due parcel.
//
//   2. THE ENFORCEMENT GUARD. Arming inventory enforcement on an unpopulated
//      catalog takes the storefront down. The warning that stands between the
//      owner and that outcome has to be right about which lines are affected,
//      and it has to be measured from the database rather than from whatever
//      the browser was holding.
//
// vitest.setup.ts installs a generic global mock for @/lib/supabase-server; the
// vi.mock below replaces it for this file with an in-memory store that honours
// filters, because "which rows are at zero" is the whole question.
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => {
  interface Row {
    [column: string]: unknown;
  }

  const tables = new Map<string, Row[]>();

  function table(name: string): Row[] {
    const existing = tables.get(name);
    if (existing) return existing;
    const created: Row[] = [];
    tables.set(name, created);
    return created;
  }

  function reset() {
    tables.clear();
  }

  type Filter = (row: Row) => boolean;

  function createBuilder(name: string, mode: "select" | "update" | "insert", payload?: Row) {
    const filters: Filter[] = [];
    const sorted: Array<{ column: string; ascending: boolean }> = [];

    const run = () => {
      if (mode === "insert" && payload) {
        table(name).push({ ...payload });
        return { data: [payload], error: null as unknown };
      }

      const rows = table(name).filter((row) => filters.every((filter) => filter(row)));
      if (mode === "update" && payload) {
        for (const row of rows) Object.assign(row, payload);
      }

      const result = [...rows];
      for (const order of [...sorted].reverse()) {
        result.sort((a, b) => {
          const left = a[order.column];
          const right = b[order.column];
          const cmp = left === right ? 0 : (left ?? "") > (right ?? "") ? 1 : -1;
          return order.ascending ? cmp : -cmp;
        });
      }
      return { data: result, error: null as unknown };
    };

    const builder = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? "") === String(value));
        return builder;
      },
      in(column: string, values: unknown[]) {
        const wanted = new Set(values.map((value) => String(value)));
        filters.push((row) => wanted.has(String(row[column] ?? "")));
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        sorted.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      maybeSingle() {
        const { data, error } = run();
        return Promise.resolve({ data: data[0] ?? null, error });
      },
      then(resolve: (value: { data: Row[]; error: unknown }) => unknown) {
        return Promise.resolve(run()).then(resolve);
      },
    };

    return builder;
  }

  const supabaseAdmin = {
    from(name: string) {
      return {
        select: () => createBuilder(name, "select"),
        update: (payload: Row) => createBuilder(name, "update", payload),
        insert: (payload: Row) => createBuilder(name, "insert", payload),
      };
    },
  };

  return { table, reset, supabaseAdmin };
});

vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: harness.supabaseAdmin }));
vi.mock("@/lib/back-in-stock", () => ({ notifyBackInStock: async () => {} }));

import {
  adjustInventoryLine,
  getInventoryReadiness,
  getInventoryRows,
  MAX_UNIT_WEIGHT_OZ,
} from "@/lib/admin-inventory";
import { DEFAULT_UNIT_WEIGHT_OZ } from "@/lib/shippo/parcel";

interface ProductSeed {
  id: string;
  name: string;
  inventory_quantity?: number;
  stock_status?: string;
  shipping_weight_oz?: number | null;
  is_archived?: boolean;
}

function seedProduct(seed: ProductSeed) {
  harness.table("products").push({
    slug: seed.id,
    category: "Research Peptides",
    low_stock_threshold: 5,
    inventory_quantity: 0,
    stock_status: "In Stock",
    shipping_weight_oz: null,
    is_archived: false,
    ...seed,
  });
}

function seedDose(seed: {
  id: string;
  product_id: string;
  label: string;
  inventory_quantity?: number;
  stock_status?: string;
  shipping_weight_oz?: number | null;
}) {
  harness.table("product_doses").push({
    sku: `${seed.id}-SKU`,
    position: 0,
    low_stock_threshold: 5,
    inventory_quantity: 0,
    stock_status: "In Stock",
    shipping_weight_oz: null,
    ...seed,
  });
}

beforeEach(() => {
  harness.reset();
});

describe("packed weight resolution", () => {
  it("prefers the dose's own weight over the product's", async () => {
    seedProduct({ id: "glp1", name: "GLP-1", shipping_weight_oz: 2 });
    seedDose({ id: "d1", product_id: "glp1", label: "10mg", shipping_weight_oz: 3.5 });

    const [line] = await getInventoryRows();
    expect(line.shippingWeightOz).toBe(3.5);
    expect(line.effectiveShippingWeightOz).toBe(3.5);
    expect(line.shippingWeightSource).toBe("line");
  });

  it("inherits the product's weight when the dose has none — NULL means inherit", async () => {
    seedProduct({ id: "glp1", name: "GLP-1", shipping_weight_oz: 2 });
    seedDose({ id: "d1", product_id: "glp1", label: "10mg", shipping_weight_oz: null });

    const [line] = await getInventoryRows();
    expect(line.shippingWeightOz).toBeNull();
    expect(line.inheritedShippingWeightOz).toBe(2);
    expect(line.effectiveShippingWeightOz).toBe(2);
    expect(line.shippingWeightSource).toBe("inherited");
  });

  it("falls back to the catalog default when nothing has been weighed", async () => {
    seedProduct({ id: "glp1", name: "GLP-1", shipping_weight_oz: null });
    seedDose({ id: "d1", product_id: "glp1", label: "10mg", shipping_weight_oz: null });

    const [line] = await getInventoryRows();
    expect(line.effectiveShippingWeightOz).toBe(DEFAULT_UNIT_WEIGHT_OZ);
    expect(line.shippingWeightSource).toBe("default");
  });

  it("treats a stored zero or negative as unset, exactly as parcel math does", async () => {
    // A 0 in the column is a mis-typed row, never a weightless vial. Surfacing
    // it as a real value would show a weight the label will never use.
    seedProduct({ id: "a", name: "Zeroed", shipping_weight_oz: 0 });
    seedProduct({ id: "b", name: "Negative", shipping_weight_oz: -4 });

    const rows = await getInventoryRows();
    for (const row of rows) {
      expect(row.shippingWeightOz).toBeNull();
      expect(row.effectiveShippingWeightOz).toBe(DEFAULT_UNIT_WEIGHT_OZ);
      expect(row.shippingWeightSource).toBe("default");
    }
  });

  it("reports a product with no doses on its own weight", async () => {
    seedProduct({ id: "water", name: "Bacteriostatic Water", shipping_weight_oz: 1.4 });

    const [line] = await getInventoryRows();
    expect(line.doseId).toBeNull();
    expect(line.effectiveShippingWeightOz).toBe(1.4);
    expect(line.shippingWeightSource).toBe("line");
  });
});

describe("inventory enforcement readiness", () => {
  it("calls an empty catalog effectively empty — there is nothing to enforce", async () => {
    const readiness = await getInventoryReadiness();
    expect(readiness.totalLines).toBe(0);
    expect(readiness.isEffectivelyEmpty).toBe(true);
  });

  it("flags a catalog where every line is still at zero", async () => {
    seedProduct({ id: "a", name: "A", inventory_quantity: 0 });
    seedProduct({ id: "b", name: "B", inventory_quantity: 0 });

    const readiness = await getInventoryReadiness();
    expect(readiness.totalLines).toBe(2);
    expect(readiness.stockedLines).toBe(0);
    expect(readiness.zeroQuantityLines).toBe(2);
    expect(readiness.isEffectivelyEmpty).toBe(true);
  });

  it("flags a catalog where MOST lines are still at zero", async () => {
    seedProduct({ id: "a", name: "A", inventory_quantity: 12 });
    seedProduct({ id: "b", name: "B", inventory_quantity: 0 });
    seedProduct({ id: "c", name: "C", inventory_quantity: 0 });
    seedProduct({ id: "d", name: "D", inventory_quantity: 0 });

    const readiness = await getInventoryReadiness();
    expect(readiness.zeroRatio).toBe(0.75);
    expect(readiness.isEffectivelyEmpty).toBe(true);
  });

  it("clears a populated catalog with a few genuinely sold-out lines", async () => {
    seedProduct({ id: "a", name: "A", inventory_quantity: 12 });
    seedProduct({ id: "b", name: "B", inventory_quantity: 4 });
    seedProduct({ id: "c", name: "C", inventory_quantity: 9 });
    seedProduct({ id: "d", name: "D", inventory_quantity: 0, stock_status: "Out of Stock" });

    const readiness = await getInventoryReadiness();
    expect(readiness.isEffectivelyEmpty).toBe(false);
    expect(readiness.stockedLines).toBe(3);
    expect(readiness.blockedLines).toBe(1);
  });

  it("counts what enforcement actually blocks — the stored status, not the quantity", async () => {
    // A line at zero whose status still reads "In Stock" stays purchasable
    // until something rewrites it, and a stocked line manually marked out is
    // blocked despite having units. Counting quantities here would raise a
    // false alarm about the first and miss the second.
    seedProduct({ id: "a", name: "Zero but sellable", inventory_quantity: 0, stock_status: "In Stock" });
    seedProduct({ id: "b", name: "Stocked but held", inventory_quantity: 40, stock_status: "Out of Stock" });
    seedProduct({ id: "c", name: "Normal", inventory_quantity: 40, stock_status: "In Stock" });

    const readiness = await getInventoryReadiness();
    expect(readiness.blockedLines).toBe(1);
    expect(readiness.sampleBlockedNames).toEqual(["Stocked but held"]);
  });

  it("names affected variants so the warning is concrete", async () => {
    seedProduct({ id: "glp1", name: "GLP-1" });
    seedDose({ id: "d1", product_id: "glp1", label: "5mg", stock_status: "Out of Stock" });
    seedDose({ id: "d2", product_id: "glp1", label: "10mg", stock_status: "Out of Stock" });

    const readiness = await getInventoryReadiness();
    expect(readiness.sampleBlockedNames).toContain("GLP-1 — 5mg");
    expect(readiness.sampleBlockedNames).toContain("GLP-1 — 10mg");
  });

  it("ignores archived products, matching what is actually sellable", async () => {
    seedProduct({ id: "live", name: "Live", inventory_quantity: 30 });
    seedProduct({ id: "dead", name: "Archived twin", inventory_quantity: 0, is_archived: true });

    const readiness = await getInventoryReadiness();
    expect(readiness.totalLines).toBe(1);
    expect(readiness.isEffectivelyEmpty).toBe(false);
  });
});

describe("editing a packed weight", () => {
  it("stores a weight rounded to hundredths of an ounce", async () => {
    seedProduct({ id: "a", name: "A" });
    await adjustInventoryLine({ productId: "a", shippingWeightOz: 1.23456 });
    expect(harness.table("products")[0].shipping_weight_oz).toBe(1.23);
  });

  it("clears the weight when null is sent, so a dose goes back to inheriting", async () => {
    seedProduct({ id: "glp1", name: "GLP-1", shipping_weight_oz: 2 });
    seedDose({ id: "d1", product_id: "glp1", label: "10mg", shipping_weight_oz: 6 });

    await adjustInventoryLine({ productId: "glp1", doseId: "d1", shippingWeightOz: null });

    const [line] = await getInventoryRows();
    expect(line.shippingWeightOz).toBeNull();
    expect(line.effectiveShippingWeightOz).toBe(2);
  });

  it("leaves the stored weight alone when the field is absent", async () => {
    seedProduct({ id: "a", name: "A", shipping_weight_oz: 3 });
    await adjustInventoryLine({ productId: "a", quantity: 10 });
    expect(harness.table("products")[0].shipping_weight_oz).toBe(3);
  });

  it("rejects zero rather than storing a weight parcel math would ignore", async () => {
    seedProduct({ id: "a", name: "A", shipping_weight_oz: 3 });
    await expect(adjustInventoryLine({ productId: "a", shippingWeightOz: 0 })).rejects.toThrow(/greater than zero/i);
    expect(harness.table("products")[0].shipping_weight_oz).toBe(3);
  });

  it("rejects a value heavier than any carrier accepts — usually pounds typed as ounces", async () => {
    seedProduct({ id: "a", name: "A" });
    await expect(adjustInventoryLine({ productId: "a", shippingWeightOz: MAX_UNIT_WEIGHT_OZ + 1 })).rejects.toThrow(/pounds/i);
  });

  it("updates a weight without disturbing the quantity or the stock status", async () => {
    seedProduct({ id: "a", name: "A", inventory_quantity: 42, stock_status: "Limited" });
    await adjustInventoryLine({ productId: "a", shippingWeightOz: 2.5 });

    const row = harness.table("products")[0];
    expect(row.inventory_quantity).toBe(42);
    expect(row.stock_status).toBe("Limited");
    expect(row.shipping_weight_oz).toBe(2.5);
  });
});
