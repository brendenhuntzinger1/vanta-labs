import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PUBLIC LIBRARY HONOURS THE HIDDEN LIST.
//
// A product on the list must not appear in the library at all: not as a
// pending card, not as a documented card, and not in the hero's counts. The
// snapshot is built from the catalogue, the COA table and the admin setting, so
// all three are stubbed and the snapshot itself is read.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  control: {} as Record<string, Record<string, unknown>>,
  coaRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProducts: async () => [
    { id: "p-bpc", slug: "bpc-157", name: "BPC-157", category: "Healing", image: "/images/bpc.png", doses: [] },
    { id: "p-hgh", slug: "hgh-gh-191", name: "HGH GH-191", category: "Growth Hormone", image: "/images/hgh.png", doses: [] },
    { id: "p-hcg", slug: "hcg", name: "HCG", category: "Specialty", image: "/images/hcg.png", doses: [] },
    { id: "p-bac", slug: "bacteriostatic-water", name: "BAC Water", category: "Solvents", image: "/images/bac.png", doses: [] },
  ],
}));

vi.mock("@/lib/admin-control", () => ({
  getControlSnapshot: async () => state.control,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve({ data: table === "coa_records" ? state.coaRows : [], error: null }).then(resolve, reject),
      };
      return query;
    },
    storage: { from: () => ({}) },
  },
}));

const { getCoaLibrarySettings, getCoaLibrarySnapshot } = await import("@/lib/coa");

function publishedCoa(productId: string, batch: string) {
  return {
    id: `coa-${productId}-${batch}`,
    product_id: productId,
    product_dose_id: null,
    strength: null,
    batch_number: batch,
    lot_number: null,
    lab_name: "Janoshik",
    test_date: "2026-08-04",
    purity: "99.2",
    identity_result: null,
    file_path: null,
    external_url: "https://lab.example/report.pdf",
    file_name: null,
    file_type: "link",
    file_size_bytes: null,
    status: "published",
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
  };
}

beforeEach(() => {
  state.control = {};
  state.coaRows = [];
});

describe("getCoaLibrarySettings", () => {
  it("falls back to the default hidden list when nothing has been saved", async () => {
    const settings = await getCoaLibrarySettings();
    expect(settings.hiddenProductSlugs).toEqual(expect.arrayContaining(["hgh-gh-191", "hcg", "bacteriostatic-water"]));
    expect(settings.showPendingProducts).toBe(true);
  });

  it("uses the saved list when there is one, including an empty one", async () => {
    state.control = { coa: { hidden_product_slugs: ["bpc-157"] } };
    expect((await getCoaLibrarySettings()).hiddenProductSlugs).toEqual(["bpc-157"]);

    state.control = { coa: { hidden_product_slugs: [] } };
    expect((await getCoaLibrarySettings()).hiddenProductSlugs).toEqual([]);
  });

  it("ignores a malformed saved value rather than hiding everything or nothing by accident", async () => {
    state.control = { coa: { hidden_product_slugs: "hcg,hgh-gh-191" } };
    const settings = await getCoaLibrarySettings();
    expect(settings.hiddenProductSlugs).toContain("hcg");
    expect(settings.hiddenProductSlugs).toContain("hgh-gh-191");
    expect(settings.hiddenProductSlugs).toContain("bacteriostatic-water");
  });
});

describe("getCoaLibrarySnapshot", () => {
  it("leaves the untested products out of the library by default", async () => {
    const snapshot = await getCoaLibrarySnapshot();
    const slugs = snapshot.products.map((product) => product.slug);
    expect(slugs).toEqual(["bpc-157"]);
  });

  it("shows everything once the owner has saved an empty hidden list", async () => {
    state.control = { coa: { hidden_product_slugs: [] } };
    const snapshot = await getCoaLibrarySnapshot();
    expect(snapshot.products.map((product) => product.slug).sort()).toEqual(
      ["bacteriostatic-water", "bpc-157", "hcg", "hgh-gh-191"],
    );
  });

  it("hides a product even when it has a published COA, and keeps it out of the counts", async () => {
    state.control = { coa: { hidden_product_slugs: ["hcg"] } };
    state.coaRows = [publishedCoa("p-hcg", "HCG-0826"), publishedCoa("p-bpc", "BPC-0826")];

    const snapshot = await getCoaLibrarySnapshot();
    expect(snapshot.products.map((product) => product.slug)).not.toContain("hcg");
    expect(snapshot.documentedProductCount).toBe(1);
    expect(snapshot.totalDocumentCount).toBe(1);
  });

  it("hides independently of the pending-products switch", async () => {
    // Pending cards off AND a hidden list: the hidden product stays hidden
    // whether or not it would otherwise have been a pending card.
    state.control = { coa: { show_pending_products: false, hidden_product_slugs: ["bpc-157"] } };
    state.coaRows = [publishedCoa("p-bpc", "BPC-0826"), publishedCoa("p-hgh", "HGH-0826")];

    const snapshot = await getCoaLibrarySnapshot();
    expect(snapshot.products.map((product) => product.slug)).toEqual(["hgh-gh-191"]);
  });
});
