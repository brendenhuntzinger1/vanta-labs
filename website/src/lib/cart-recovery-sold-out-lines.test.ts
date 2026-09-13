import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "@/lib/catalog-types";

// ---------------------------------------------------------------------------
// A RECOVERY EMAIL MUST NOT ADVERTISE WHAT THE TILL WILL NOT SELL.
//
// The gift ladder has checked stock since a top-band cart mailed a three-product
// promise the checkout then honoured two thirds of. The CART lines never did.
// So the four-message series could print a sold-out product, price it, total it,
// and walk the shopper back to a basket that cannot be paid for — the single
// worst outcome available to a programme whose whole job is to close a sale.
//
// It was also an ECONOMIC defect, not only a customer-experience one.
// reconciledCartValueCents sizes the offer band on exactly the lines this email
// prints, so an unbuyable line bought a bigger gift than the buyable basket
// justified: a $95.98 basket carrying a sold-out $424 line drew the top band's
// three free products.
//
// The test is the same dual one quoteOrder and the gift check use — status AND
// tracked count — because resolveStockStatus() reports "In Stock" for every
// product while the global inventory-tracking flag is off, which is its default
// here. Status alone calls an empty shelf available; count alone calls an
// untracked product empty.
// ---------------------------------------------------------------------------

const catalogState = vi.hoisted(() => ({
  products: [] as Product[],
  /** Keyed as getStockLevelsBySlugs keys it: slug for a product, dose id for a variant. */
  levels: new Map<string, number>(),
  /** Set to make the stock read throw, to pin the fail-open direction. */
  stockThrows: false,
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    catalogState.products.filter((product) => slugs.includes(product.slug)),
  getStockLevelsBySlugs: async () => {
    if (catalogState.stockThrows) throw new Error("stock read failed");
    return new Map(catalogState.levels);
  },
}));

const { loadRecoveryCatalogue, recoveryEmailItems, reconciledCartValueCents } =
  await import("@/lib/cart-recovery");

/** A product with two doses, the 5mg default. Only the fields this path reads. */
function product(overrides: {
  slug: string;
  name: string;
  price: string;
  stockStatus?: Product["stockStatus"];
  doses?: Array<{ id: string; label: string; price: string; isDefault: boolean; stockStatus?: Product["stockStatus"] }>;
}): Product {
  return {
    slug: overrides.slug,
    name: overrides.name,
    category: "peptides",
    price: overrides.price,
    stockStatus: overrides.stockStatus ?? "In Stock",
    batchNumber: "B-1",
    description: "",
    doses: (overrides.doses ?? []).map((dose, index) => ({
      id: dose.id,
      label: dose.label,
      slugSuffix: dose.label,
      price: dose.price,
      isDefault: dose.isDefault,
      isEnabled: true,
      position: index,
      ...(dose.stockStatus ? { stockStatus: dose.stockStatus } : {}),
    })),
  } as Product;
}

beforeEach(() => {
  catalogState.products = [];
  catalogState.levels = new Map();
  catalogState.stockThrows = false;
});

describe("loadRecoveryCatalogue reads availability the way the till does", () => {
  it("marks a product Out of Stock even though it has a price and a name", async () => {
    catalogState.products = [product({ slug: "tb-500", name: "TB-500", price: "79.00", stockStatus: "Out of Stock" })];
    const catalogue = await loadRecoveryCatalogue(["tb-500"]);
    expect(catalogue.get("tb-500")?.unshippable).toBe(true);
  });

  it("marks a Reserved product unshippable too — held is not available", async () => {
    catalogState.products = [product({ slug: "tb-500", name: "TB-500", price: "79.00", stockStatus: "Reserved" })];
    expect((await loadRecoveryCatalogue(["tb-500"])).get("tb-500")?.unshippable).toBe(true);
  });

  it("catches an empty shelf the STATUS hides, which is the default configuration", async () => {
    // resolveStockStatus() returns "In Stock" for everything while the global
    // inventory flag is off. The tracked count is not masked that way, and this
    // is exactly the case the gift check was rewritten for.
    catalogState.products = [product({ slug: "tb-500", name: "TB-500", price: "79.00", stockStatus: "In Stock" })];
    catalogState.levels = new Map([["tb-500", 0]]);
    expect((await loadRecoveryCatalogue(["tb-500"])).get("tb-500")?.unshippable).toBe(true);
  });

  it("leaves an untracked product shippable — no count is not a count of zero", async () => {
    catalogState.products = [product({ slug: "tb-500", name: "TB-500", price: "79.00" })];
    catalogState.levels = new Map();
    expect((await loadRecoveryCatalogue(["tb-500"])).get("tb-500")?.unshippable).toBeUndefined();
  });

  it("judges each dose separately, because availability is per dose", async () => {
    catalogState.products = [product({
      slug: "glp-3",
      name: "GLP-3",
      price: "49.99",
      doses: [
        { id: "dose-5", label: "5mg", price: "49.99", isDefault: true },
        { id: "dose-10", label: "10mg", price: "169.99", isDefault: false, stockStatus: "Out of Stock" },
      ],
    })];
    const entry = (await loadRecoveryCatalogue(["glp-3"])).get("glp-3");
    expect(entry?.unshippableVariants?.has("dose-10")).toBe(true);
    expect(entry?.unshippableVariants?.has("dose-5")).toBe(false);
    // The PRODUCT is judged on the dose a line naming no variant would get —
    // the default — so a sold-out 10mg must not condemn the whole listing.
    expect(entry?.unshippable).toBeUndefined();
  });

  it("prices every line as available when the stock read fails", async () => {
    // The till still guards the real order. An email missing its cart entirely
    // is a worse outcome than one line that turns out to be unavailable, and a
    // transient read must never be able to empty the series.
    catalogState.products = [product({ slug: "tb-500", name: "TB-500", price: "79.00" })];
    catalogState.stockThrows = true;
    expect((await loadRecoveryCatalogue(["tb-500"])).get("tb-500")?.unshippable).toBeUndefined();
  });
});

describe("recoveryEmailItems drops what cannot be bought", () => {
  const shelf = new Map([
    ["bpc-157", { name: "BPC-157", unitPriceCents: 6_900 }],
    ["tb-500", { name: "TB-500", unitPriceCents: 42_400, unshippable: true }],
  ]);

  it("does not print, price or total a sold-out line", () => {
    const items = recoveryEmailItems(
      [{ slug: "bpc-157", quantity: 1 }, { slug: "tb-500", quantity: 1 }],
      shelf,
    );
    expect(items.map((item) => item.name)).toEqual(["BPC-157"]);
  });

  it("sizes the offer band on the basket that is left, not on the one that was stored", () => {
    // THE ECONOMIC HALF. $69.00 of buyable goods must draw the $69 band, not
    // the $493.90 one the sold-out line would have bought.
    const items = recoveryEmailItems(
      [{ slug: "bpc-157", quantity: 1 }, { slug: "tb-500", quantity: 1 }],
      shelf,
    );
    expect(reconciledCartValueCents(items, 49_390)).toBe(6_900);
  });

  it("produces no lines at all when nothing in the cart can ship", () => {
    // The sweep declines to send on an empty line list, which is the right
    // outcome: there is no honest email to build from a cart of sold-out goods.
    expect(recoveryEmailItems([{ slug: "tb-500", quantity: 2 }], shelf)).toEqual([]);
  });

  it("keeps the buyable dose of a product whose other dose is gone", () => {
    const glp = new Map([["glp-3", {
      name: "GLP-3",
      unitPriceCents: 4_999,
      variantPriceCents: new Map([["dose-5", 4_999], ["dose-10", 16_999]]),
      variantLabel: new Map([["dose-5", "5mg"], ["dose-10", "10mg"]]),
      unshippableVariants: new Set(["dose-10"]),
    }]]);
    const items = recoveryEmailItems(
      [{ slug: "glp-3", variantId: "dose-10", quantity: 1 }, { slug: "glp-3", variantId: "dose-5", quantity: 2 }],
      glp,
    );
    expect(items).toEqual([{ name: "GLP-3 5mg", quantity: 2, unitPriceCents: 4_999 }]);
  });

  it("judges a line that names a dose by THAT dose, not by the product's default", () => {
    // The inverse of the case above, and the one a product-level-only check
    // gets wrong in the expensive direction: the default sold out, the dose in
    // the cart did not, and dropping it would delete a payable line.
    const glp = new Map([["glp-3", {
      name: "GLP-3",
      unitPriceCents: 4_999,
      variantPriceCents: new Map([["dose-10", 16_999]]),
      unshippable: true,
      unshippableVariants: new Set(["dose-5"]),
    }]]);
    const items = recoveryEmailItems([{ slug: "glp-3", variantId: "dose-10", quantity: 1 }], glp);
    expect(items).toHaveLength(1);
    expect(items[0].unitPriceCents).toBe(16_999);
  });

  it("keeps a dose the catalogue does not know, for the same reason a silent read is kept", () => {
    const glp = new Map([["glp-3", {
      name: "GLP-3",
      unitPriceCents: 4_999,
      unshippableVariants: new Set(["dose-5"]),
    }]]);
    expect(recoveryEmailItems([{ slug: "glp-3", variantId: "dose-99", quantity: 1 }], glp)).toHaveLength(1);
  });
});
