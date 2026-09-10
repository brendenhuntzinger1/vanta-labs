import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A DELIBERATE STOCK EDIT MUST NOT OVERWRITE A SALE THAT LANDED MID-EDIT.
//
// admin-product-save-preserves-stock.test.ts covers the DECISION — whether
// stock belongs in the write at all. This covers what happens when it does: the
// write is constrained to the row still holding the value the editor loaded, so
// it either applies or it does not, and a shopper's order placed while the form
// was open is refused loudly rather than silently reverted.
//
// Worth its own file with its own fake because the fake has to answer the one
// question the decision test cannot reach: how many rows the update matched.
// The existing dose-replacement fake deliberately does not implement .select(),
// which is how the first version of this fix was caught — it called .select()
// on every update, including the ones with no stock in them, and broke eleven
// tests that had every right to a client without it.
// ---------------------------------------------------------------------------

type DoseRow = {
  id: string;
  slug_suffix: string | null;
  label?: string;
  inventory_quantity: number;
};

const state: { doses: DoseRow[]; updates: Array<Record<string, unknown>> } = { doses: [], updates: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: vi.fn() }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table !== "product_doses") {
      // replaceProductDoses also syncs the parent `products` row. Nothing here
      // asserts on that; it just has to not throw.
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    return {
      select: () => {
        const b: Record<string, unknown> = {
          eq() { return b; },
          order() { return b; },
          limit() { return b; },
          async maybeSingle() { return { data: state.doses[0] ?? null, error: null }; },
          then(resolve: (v: { data: unknown; error: null }) => unknown) {
            return Promise.resolve({ data: [...state.doses], error: null }).then(resolve);
          },
        };
        return b;
      },
      insert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      update: (values: Record<string, unknown>) => {
        // Filters accumulate exactly as PostgREST applies them: every .eq()
        // narrows the set of rows the update will touch.
        const filters: Array<[string, unknown]> = [];
        const apply = () => {
          const matched = state.doses.filter((row) =>
            filters.every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val));
          for (const row of matched) Object.assign(row, values);
          state.updates.push({ values, filters: [...filters] });
          return matched;
        };
        const builder: Record<string, unknown> = {
          eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
          select() {
            const matched = apply();
            return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
          },
          then(resolve: (v: { error: null }) => unknown) {
            apply();
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      },
    };
  };
  return { supabaseAdmin: { from } };
});

const { replaceProductDoses } = await import("@/lib/admin-products");

const dose = (over: Record<string, unknown> = {}) => ({
  id: "dose-1",
  label: "10mg",
  slugSuffix: "10mg",
  priceCents: 5900,
  inventoryQuantity: 12,
  ...over,
});

beforeEach(() => {
  state.doses = [{ id: "dose-1", slug_suffix: "10mg", label: "10mg", inventory_quantity: 12 }];
  state.updates = [];
});

describe("a stock edit is a compare-and-set", () => {
  it("applies when the shelf still holds what the editor loaded", async () => {
    await replaceProductDoses("prod-1", [dose({ inventoryQuantity: 40, inventoryQuantityAtLoad: 12 })]);
    expect(state.doses[0].inventory_quantity).toBe(40);
  });

  it("refuses, and changes nothing, when a sale landed while the form was open", async () => {
    // The admin loaded 12 and typed 40. Two units sold in between.
    state.doses[0].inventory_quantity = 10;

    await expect(
      replaceProductDoses("prod-1", [dose({ inventoryQuantity: 40, inventoryQuantityAtLoad: 12 })]),
    ).rejects.toThrow(/changed while you were editing/i);

    // The sale survives. This is the whole point: 10, not 40, and not 12.
    expect(state.doses[0].inventory_quantity).toBe(10);
  });

  it("names the real current count so the admin can decide what to do", async () => {
    state.doses[0].inventory_quantity = 7;
    await expect(
      replaceProductDoses("prod-1", [dose({ inventoryQuantity: 40, inventoryQuantityAtLoad: 12 })]),
    ).rejects.toThrow(/it is now 7/i);
  });

  it("does not constrain the write when stock was left alone", async () => {
    // An ordinary edit: a sale lands mid-edit and must be untouched, with no
    // conflict raised, because the admin never claimed anything about stock.
    state.doses[0].inventory_quantity = 10;
    await replaceProductDoses("prod-1", [
      dose({ label: "10 mg", inventoryQuantity: 12, inventoryQuantityAtLoad: 12 }),
    ]);

    expect(state.doses[0].inventory_quantity).toBe(10);
    expect(state.doses[0].label).toBe("10 mg");
    // No inventory filter was applied, and no stock column was written.
    const write = state.updates.at(-1)!;
    expect((write.filters as Array<[string, unknown]>).some(([c]) => c === "inventory_quantity")).toBe(false);
    expect(write.values).not.toHaveProperty("inventory_quantity");
  });
});
