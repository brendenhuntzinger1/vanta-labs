import { describe, expect, it, vi } from "vitest";

// A product create with a malformed dose used to insert the products row and
// THEN crash mapping the dose, leaving a half-made product behind a raw
// TypeError. Nothing may be written until every dose is well-formed.

const inserts = vi.hoisted(() => [] as string[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async () => { inserts.push(table); return { error: null }; },
      select: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}));

describe("createAdminProduct with a malformed dose", () => {
  it("refuses with a human message before writing anything", async () => {
    const { createAdminProduct } = await import("@/lib/admin-products");
    await expect(
      createAdminProduct({
        name: "Lean QA Peptide",
        category: "peptides",
        priceCents: 3300,
        isPublished: false,
        doses: [{ label: "5mg", priceCents: 3300, inventoryQuantity: 7 } as never],
      } as never),
    ).rejects.toThrow(/Dose 1 needs a label and a slug suffix/);
    expect(inserts).toEqual([]);
  });

  it("assertDosesWellFormed accepts a complete dose and rejects a missing price", async () => {
    const { assertDosesWellFormed } = await import("@/lib/admin-products");
    expect(() => assertDosesWellFormed([{ label: "5mg", slugSuffix: "5mg", priceCents: 3300, inventoryQuantity: 1 } as never])).not.toThrow();
    expect(() => assertDosesWellFormed([{ label: "5mg", slugSuffix: "5mg", inventoryQuantity: 1 } as never])).toThrow(/needs a price/);
    expect(() => assertDosesWellFormed(undefined)).not.toThrow();
  });
});
