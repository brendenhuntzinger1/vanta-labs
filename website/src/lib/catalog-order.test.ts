import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/catalog-types";
import { inDefaultCatalogOrder, isSoldOut, sortCatalogBy } from "@/lib/catalog-order";

// ---------------------------------------------------------------------------
// A sold-out card is a dead end: it cannot be added to the cart, so every one
// of them sitting above something purchasable is a row of the grid that sells
// nothing. The rule is therefore ABSOLUTE — it survives every sort the shopper
// can choose, not just the catalogue's resting order.
// ---------------------------------------------------------------------------

function product(slug: string, overrides: Partial<Product> = {}): Product {
  return {
    slug,
    name: slug,
    category: "Peptides",
    price: "$100.00",
    stockStatus: "In Stock",
    batchNumber: "B-1",
    description: "",
    image: "",
    testingDate: "2026-01-01",
    labName: "Vanta Analytical",
    coaUrl: "",
    ...overrides,
  };
}

const soldOutStatuses = ["Out of Stock", "Reserved"] as const;
const availableStatuses = ["In Stock", "Limited"] as const;

const slugs = (products: Product[]) => products.map((entry) => entry.slug);

describe("isSoldOut", () => {
  for (const status of soldOutStatuses) {
    it(`treats ${status} as sold out`, () => {
      expect(isSoldOut(product("a", { stockStatus: status }))).toBe(true);
    });
  }

  for (const status of availableStatuses) {
    it(`treats ${status} as buyable`, () => {
      expect(isSoldOut(product("a", { stockStatus: status }))).toBe(false);
    });
  }

  it("does not call a product sold out just because it has no status", () => {
    // An untracked catalogue resolves to In Stock; a missing value must never
    // sink a product that is perfectly purchasable.
    expect(isSoldOut(product("a", { stockStatus: undefined as unknown as Product["stockStatus"] }))).toBe(false);
  });
});

describe("sortCatalogBy keeps sold-out products at the bottom", () => {
  it("sinks them under the default order, below every best seller AND every in-stock product", () => {
    const products = [
      product("sold-out-best-seller", { stockStatus: "Out of Stock", isBestSeller: true }),
      product("plain"),
      product("best-seller", { isBestSeller: true }),
      product("reserved", { stockStatus: "Reserved" }),
    ];

    expect(slugs(sortCatalogBy(products, "default"))).toEqual([
      "best-seller",
      "plain",
      "sold-out-best-seller",
      "reserved",
    ]);
  });

  it("sinks them under price: low to high, even when they are the cheapest", () => {
    const products = [
      product("cheap-sold-out", { price: "$10.00", stockStatus: "Out of Stock" }),
      product("dear", { price: "$300.00" }),
      product("mid", { price: "$120.00" }),
    ];

    expect(slugs(sortCatalogBy(products, "price-asc"))).toEqual(["mid", "dear", "cheap-sold-out"]);
  });

  it("sinks them under price: high to low, even when they are the dearest", () => {
    const products = [
      product("dear-sold-out", { price: "$900.00", stockStatus: "Out of Stock" }),
      product("mid", { price: "$120.00" }),
      product("dear", { price: "$300.00" }),
    ];

    expect(slugs(sortCatalogBy(products, "price-desc"))).toEqual(["dear", "mid", "dear-sold-out"]);
  });

  it("sinks them under name: A to Z, even when they sort first alphabetically", () => {
    const products = [
      product("aaa", { name: "AAA", stockStatus: "Out of Stock" }),
      product("ccc", { name: "CCC" }),
      product("bbb", { name: "BBB" }),
    ];

    expect(slugs(sortCatalogBy(products, "name-asc"))).toEqual(["bbb", "ccc", "aaa"]);
  });

  it("sinks them under purity: highest, even when they are the purest", () => {
    const products = [
      product("purest-sold-out", { purityResult: "99.9%", stockStatus: "Reserved" }),
      product("pure", { purityResult: "98.1%" }),
      product("purer", { purityResult: "99.2%" }),
    ];

    expect(slugs(sortCatalogBy(products, "purity"))).toEqual(["purer", "pure", "purest-sold-out"]);
  });

  it("still sorts the sold-out products among themselves", () => {
    // They go to the bottom as a block, but the chosen sort still applies
    // inside it — the shopper's choice is honoured, not discarded.
    const products = [
      product("dear-sold-out", { price: "$300.00", stockStatus: "Out of Stock" }),
      product("cheap-sold-out", { price: "$10.00", stockStatus: "Out of Stock" }),
      product("stocked", { price: "$120.00" }),
    ];

    expect(slugs(sortCatalogBy(products, "price-asc"))).toEqual([
      "stocked",
      "cheap-sold-out",
      "dear-sold-out",
    ]);
  });

  it("leaves the input array untouched", () => {
    const products = [product("sold-out", { stockStatus: "Out of Stock" }), product("stocked")];
    sortCatalogBy(products, "default");
    expect(slugs(products)).toEqual(["sold-out", "stocked"]);
  });
});

describe("inDefaultCatalogOrder", () => {
  it("is the default sort, so the server fallback and the hydrated grid agree", () => {
    const products = [
      product("sold-out", { stockStatus: "Out of Stock" }),
      product("plain"),
      product("best-seller", { isBestSeller: true }),
    ];

    expect(slugs(inDefaultCatalogOrder(products))).toEqual(slugs(sortCatalogBy(products, "default")));
    expect(slugs(inDefaultCatalogOrder(products))).toEqual(["best-seller", "plain", "sold-out"]);
  });
});
