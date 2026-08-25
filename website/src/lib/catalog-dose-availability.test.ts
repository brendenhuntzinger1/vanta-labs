import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A DOSED PRODUCT'S STOCK LIVES ON ITS DOSE, NOT ON ITS PARENT ROW.
//
// WHY THIS FILE EXISTS. An audit of production reported "17 of 38 published
// products are sold out" and it was wrong. The query read
// products.inventory_quantity. For a product sold through doses that column is
// not the shelf — product_doses.inventory_quantity is. Fifteen of the
// seventeen had stock: 553 units the query could not see. The owner's own
// figure, 1139 units, only reconciles against the dose table.
//
// The production code was right the whole time. catalog.ts takes availability
// from the DEFAULT DOSE when one exists and only falls back to the parent row
// for an undosed product; quote-order.ts keys its oversell guard on the dose
// id; the admin inventory screen emits one line per dose. Nothing was broken.
// What was missing was a test that would have caught the mistake.
//
// zero-stock.test.ts covers the zero rule, but it does it by copying
// resolveStockStatus into the test file and asserting that catalog.ts CONTAINS
// certain strings. A mirrored copy cannot catch a change in the original, and
// a string match cannot tell you which row the number came from. Neither would
// have flagged reading the wrong table — which is exactly the mistake that got
// made.
//
// So this drives the REAL getCatalogProductsBySlugs against the exact shape 15
// of the live products are in: parent row at 0, default dose stocked.
// ---------------------------------------------------------------------------

const PRODUCT_ID = "prod-1";
const DOSE_ID = "dose-10mg";

const state = {
  inventoryActive: true,
  /** The parent row's count — 0 in production for every dosed product. */
  productQuantity: 0,
  productReserved: 0,
  doses: [] as Array<Record<string, unknown>>,
  doseReserved: {} as Record<string, number>,
};

vi.mock("server-only", () => ({}));

// vitest.setup.ts mocks @/lib/catalog globally, for every suite in the repo.
// That is why nothing was testing the real availability logic: every other file
// gets a hand-written stub whose stockStatus is a constant. Unmocked here so
// this drives the actual implementation.
vi.unmock("@/lib/catalog");
vi.mock("@/lib/inventory-settings", () => ({
  isInventoryTrackingActive: async () => state.inventoryActive,
}));

/** Minimal PostgREST-shaped builder: every chainable call returns itself. */
function result(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "in", "eq", "order", "limit", "not", "is"]) {
    builder[method] = chain;
  }
  // Awaiting the builder resolves to the PostgREST envelope.
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: rows, error: null });
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "products") {
        // fetchReservedQuantities asks for (id, reserved_quantity); the catalog
        // query asks for the full column list. Both are served the same row.
        return result([
          {
            id: PRODUCT_ID,
            slug: "glp-1",
            name: "GLP-1",
            category: "Research Peptides",
            price_cents: 9999,
            sale_price_cents: 0,
            compare_at_price_cents: 0,
            stock_status: "In Stock",
            inventory_quantity: state.productQuantity,
            reserved_quantity: state.productReserved,
            is_published: true,
            is_active: true,
            is_enabled: true,
            is_archived: false,
          },
        ]);
      }
      if (table === "product_doses") {
        return result(
          state.doses.map((dose) => ({
            ...dose,
            product_id: PRODUCT_ID,
            reserved_quantity: state.doseReserved[String(dose.id)] ?? 0,
          })),
        );
      }
      if (table === "product_images") return result([]);
      return result([]);
    },
  },
}));

const { getCatalogProductsBySlugs } = await import("@/lib/catalog");

function dose(overrides: Record<string, unknown> = {}) {
  return {
    id: DOSE_ID,
    label: "10mg",
    slug_suffix: "10mg",
    sku: "GLP1-10",
    price_cents: 9999,
    compare_at_price_cents: 0,
    sale_price_cents: 0,
    inventory_quantity: 92,
    stock_status: "In Stock",
    is_default: true,
    is_enabled: true,
    position: 0,
    ...overrides,
  };
}

beforeEach(() => {
  state.inventoryActive = true;
  state.productQuantity = 0;
  state.productReserved = 0;
  state.doses = [dose()];
  state.doseReserved = {};
});

describe("the shape 15 live products are actually in", () => {
  /**
   * THE EXACT FALSE ALARM. Parent row reads 0, the dose holds 92. Anything
   * that reports this product as sold out is reading the wrong table.
   */
  it("a parent row of 0 with a stocked default dose is IN STOCK", async () => {
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("In Stock");
    expect(product.availableQuantity).toBeGreaterThan(0);
  });

  it("is still In Stock when the parent row is 0 and the dose is merely low", async () => {
    state.doses = [dose({ inventory_quantity: 1 })];
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("In Stock");
  });

  /** The other direction: an empty dose is empty, whatever the parent says. */
  it("a stocked parent row does NOT rescue an empty default dose", async () => {
    state.productQuantity = 500;
    state.doses = [dose({ inventory_quantity: 0 })];
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("Out of Stock");
  });

  it("holds on the DOSE reduce availability; holds on the parent do not", async () => {
    state.doses = [dose({ inventory_quantity: 5 })];
    state.doseReserved = { [DOSE_ID]: 5 };
    const [heldByDose] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(heldByDose.stockStatus).toBe("Out of Stock");

    state.doseReserved = {};
    state.productReserved = 999;
    const [heldByParent] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(heldByParent.stockStatus).toBe("In Stock");
  });
});

describe("an undosed product still uses its own row", () => {
  it("falls back to the parent count when there are no doses", async () => {
    state.doses = [];
    state.productQuantity = 12;
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("In Stock");
  });

  /** cerebrolysin and pinealon in production: no enabled dose, parent at 0. */
  it("is Out of Stock when undosed and the parent row is 0", async () => {
    state.doses = [];
    state.productQuantity = 0;
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("Out of Stock");
  });
});

describe("tracking off restores the old behaviour exactly", () => {
  it("everything is In Stock when inventory tracking is disabled", async () => {
    state.inventoryActive = false;
    state.productQuantity = 0;
    state.doses = [dose({ inventory_quantity: 0 })];
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(product.stockStatus).toBe("In Stock");
  });
});

describe("what reaches the browser", () => {
  /**
   * Shelf depth is the owner's commercial information. The published object
   * carries a capped availability, never the raw count.
   */
  it("never serialises the real stock depth", async () => {
    state.doses = [dose({ inventory_quantity: 92 })];
    const [product] = await getCatalogProductsBySlugs(["glp-1"]);
    expect(JSON.stringify(product)).not.toContain("92");
    expect(product).not.toHaveProperty("inventoryQuantity");
  });
});
