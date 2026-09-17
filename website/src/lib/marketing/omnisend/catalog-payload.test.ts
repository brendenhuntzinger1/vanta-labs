import { describe, expect, it } from "vitest";

import type { Product, ProductDose } from "@/lib/catalog-types";
import {
  buildOmnisendCategories,
  buildOmnisendProduct,
  omnisendVariantId,
  parseMoney,
  slugifyCategory,
} from "@/lib/marketing/omnisend/catalog-payload";

/**
 * Pins the shape Omnisend reads from `POST /api/products` (spec §5.3): id and
 * url, the four stock statuses, formatted-string money, images made absolute
 * and placeholder-resolved, variants from doses, and the one-variant fallback
 * that keeps a product from ever being rejected as variant-less.
 */

const ORIGIN = "https://www.example.com";

function product(overrides: Partial<Product> = {}): Product {
  return {
    slug: "bpc-157",
    name: "BPC-157",
    category: "Research Peptides",
    price: "$42.99",
    stockStatus: "In Stock",
    image: "/images/bpc-157.png",
    ...overrides,
  } as Product;
}

function dose(overrides: Partial<ProductDose> = {}): ProductDose {
  return {
    id: "d-5mg",
    label: "5mg",
    price: "$42.99",
    isEnabled: true,
    isDefault: true,
    ...overrides,
  } as ProductDose;
}

describe("buildOmnisendProduct identity", () => {
  it("uses the slug as id and the product page as url", () => {
    const built = buildOmnisendProduct(product(), ORIGIN);
    expect(built.id).toBe("bpc-157");
    expect(built.url).toBe("https://www.example.com/products/bpc-157");
    expect(built.title).toBe("BPC-157");
    expect(built.currency).toBe("USD");
    expect(built.vendor).toBe("Vanta Labs");
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(buildOmnisendProduct(product(), `${ORIGIN}/`).url).toBe("https://www.example.com/products/bpc-157");
  });
});

describe("buildOmnisendProduct status", () => {
  it.each([
    ["In Stock", "inStock"],
    ["Limited", "inStock"],
    ["Reserved", "inStock"],
    ["Out of Stock", "outOfStock"],
  ] as const)("maps %s to %s", (stockStatus, expected) => {
    expect(buildOmnisendProduct(product({ stockStatus }), ORIGIN).status).toBe(expected);
  });

  it("is notAvailable when the caller says the product is off the shelf, whatever the stock says", () => {
    const built = buildOmnisendProduct(product({ stockStatus: "In Stock", doses: [dose()] }), ORIGIN, { available: false });
    expect(built.status).toBe("notAvailable");
    expect(built.variants.map((variant) => variant.status)).toEqual(["notAvailable"]);
  });
});

describe("parseMoney", () => {
  it.each([
    ["$42.99", 42.99],
    ["1,299.00", 1299],
    ["$1,299.50", 1299.5],
    [" $5 ", 5],
    ["42", 42],
  ])("reads %s as %s", (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([[""], ["   "], [undefined], [null], ["Free"], ["$"]])("returns null for %s", (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe("buildOmnisendProduct description", () => {
  it("strips tags, collapses whitespace and trims to 1000 characters after stripping", () => {
    const built = buildOmnisendProduct(product({ shortDescription: `<p>${"a".repeat(1200)}</p>` }), ORIGIN);
    expect(built.description).toHaveLength(1000);
    expect(built.description).toBe("a".repeat(1000));
  });

  it("keeps the words and drops the markup", () => {
    const built = buildOmnisendProduct(product({ shortDescription: "<p>Hello <b>world</b>\n  again</p>" }), ORIGIN);
    expect(built.description).toBe("Hello world again");
  });

  it("omits the description when there is nothing to say", () => {
    expect(buildOmnisendProduct(product({ shortDescription: undefined }), ORIGIN).description).toBeUndefined();
    expect(buildOmnisendProduct(product({ shortDescription: "<p></p>" }), ORIGIN).description).toBeUndefined();
  });
});

describe("buildOmnisendProduct images", () => {
  it("makes a stored path absolute and leads the images with the cover", () => {
    const built = buildOmnisendProduct(
      product({
        coverImage: "/images/cover.png",
        galleryImages: [
          { id: "g1", imageUrl: "https://cdn.example.com/storage/gallery-1.png", altText: null, isPrimary: false, position: 1 },
          { id: "g2", imageUrl: "/images/gallery-2.png", altText: null, isPrimary: false, position: 2 },
        ],
      }),
      ORIGIN,
    );
    expect(built.defaultImageUrl).toBe("https://www.example.com/images/cover.png");
    expect(built.images).toEqual([
      "https://www.example.com/images/cover.png",
      "https://cdn.example.com/storage/gallery-1.png",
      "https://www.example.com/images/gallery-2.png",
    ]);
  });

  it("falls back to the absolute neutral placeholder when the product has no photo", () => {
    const built = buildOmnisendProduct(product({ image: "", coverImage: undefined }), ORIGIN);
    expect(built.defaultImageUrl).toBe("https://www.example.com/images/product-placeholder.png");
    expect(built.images).toEqual(["https://www.example.com/images/product-placeholder.png"]);
  });

  it("resolves the legacy screenshot path to the placeholder and never lists a placeholder gallery image", () => {
    const built = buildOmnisendProduct(
      product({
        coverImage: "/images/vantalabs.png",
        galleryImages: [{ id: "g1", imageUrl: "/images/product-placeholder.png", altText: null, isPrimary: false, position: 1 }],
      }),
      ORIGIN,
    );
    expect(built.defaultImageUrl).toBe("https://www.example.com/images/product-placeholder.png");
    expect(built.images).toEqual(["https://www.example.com/images/product-placeholder.png"]);
  });

  it("does not repeat the cover when the gallery lists it too", () => {
    const built = buildOmnisendProduct(
      product({
        coverImage: "/images/cover.png",
        galleryImages: [{ id: "g1", imageUrl: "/images/cover.png", altText: null, isPrimary: true, position: 0 }],
      }),
      ORIGIN,
    );
    expect(built.images).toEqual(["https://www.example.com/images/cover.png"]);
  });
});

describe("buildOmnisendProduct variants from doses", () => {
  it("emits one variant per enabled dose, skipping disabled ones", () => {
    const built = buildOmnisendProduct(
      product({
        coverImage: "/images/cover.png",
        doses: [
          dose({ id: "d-5mg", label: "5mg", sku: "BPC-5", price: "$42.99", stockStatus: "In Stock" }),
          dose({ id: "d-10mg", label: "10mg", sku: "BPC-10", price: "$79.00", salePrice: "$69.00", stockStatus: "Out of Stock", imageUrl: "/images/10mg.png" }),
          dose({ id: "d-off", label: "Retired", price: "$1.00", isEnabled: false }),
        ],
      }),
      ORIGIN,
    );
    expect(built.variants).toEqual([
      {
        id: "bpc-157__d-5mg",
        title: "5mg",
        sku: "BPC-5",
        price: 42.99,
        strikeThroughPrice: undefined,
        status: "inStock",
        url: "https://www.example.com/products/bpc-157",
        defaultImageUrl: "https://www.example.com/images/cover.png",
      },
      {
        id: "bpc-157__d-10mg",
        title: "10mg",
        sku: "BPC-10",
        price: 69,
        strikeThroughPrice: undefined,
        status: "outOfStock",
        url: "https://www.example.com/products/bpc-157",
        defaultImageUrl: "https://www.example.com/images/10mg.png",
      },
    ]);
  });

  it("gives a dose without its own stock status the product's status", () => {
    const built = buildOmnisendProduct(product({ stockStatus: "Out of Stock", doses: [dose({ stockStatus: undefined })] }), ORIGIN);
    expect(built.variants[0].status).toBe("outOfStock");
  });

  it("sets strikeThroughPrice from compareAtPrice only when it is higher than the price charged", () => {
    const higher = buildOmnisendProduct(product({ doses: [dose({ price: "$40.00", compareAtPrice: "$50.00" })] }), ORIGIN);
    expect(higher.variants[0].strikeThroughPrice).toBe(50);

    const lower = buildOmnisendProduct(product({ doses: [dose({ price: "$40.00", compareAtPrice: "$30.00" })] }), ORIGIN);
    expect(lower.variants[0].strikeThroughPrice).toBeUndefined();

    const equal = buildOmnisendProduct(product({ doses: [dose({ price: "$40.00", compareAtPrice: "$40.00" })] }), ORIGIN);
    expect(equal.variants[0].strikeThroughPrice).toBeUndefined();

    const onSale = buildOmnisendProduct(product({ doses: [dose({ price: "$40.00", salePrice: "$35.00", compareAtPrice: "$38.00" })] }), ORIGIN);
    expect(onSale.variants[0].price).toBe(35);
    expect(onSale.variants[0].strikeThroughPrice).toBe(38);
  });

  it("skips a dose whose price cannot be read, and never emits a null price", () => {
    const built = buildOmnisendProduct(
      product({ doses: [dose({ id: "d-a", price: "" }), dose({ id: "d-b", price: "$10.00" })] }),
      ORIGIN,
    );
    expect(built.variants.map((variant) => variant.id)).toEqual(["bpc-157__d-b"]);
    for (const variant of built.variants) expect(typeof variant.price).toBe("number");
  });

  it("falls back to an unpriced notAvailable default variant when every dose was unreadable", () => {
    const built = buildOmnisendProduct(product({ price: "$42.99", doses: [dose({ price: "" })] }), ORIGIN);
    expect(built.variants).toHaveLength(1);
    expect(built.variants[0]).toMatchObject({ id: "bpc-157__default", price: 0, status: "notAvailable" });
  });
});

describe("buildOmnisendProduct without doses", () => {
  it("emits a single default variant priced from the product", () => {
    const built = buildOmnisendProduct(
      product({ price: "$42.99", compareAtPrice: "$55.00", stockStatus: "Limited", coverImage: "/images/cover.png" }),
      ORIGIN,
    );
    expect(built.variants).toEqual([
      {
        id: "bpc-157__default",
        title: "BPC-157",
        price: 42.99,
        strikeThroughPrice: 55,
        status: "inStock",
        url: "https://www.example.com/products/bpc-157",
        defaultImageUrl: "https://www.example.com/images/cover.png",
      },
    ]);
  });

  it("prefers the sale price and mirrors the product status", () => {
    const built = buildOmnisendProduct(product({ price: "$42.99", salePrice: "$39.99", stockStatus: "Out of Stock" }), ORIGIN);
    expect(built.variants[0]).toMatchObject({ price: 39.99, status: "outOfStock" });
  });

  it("treats an empty dose list the same as no doses", () => {
    const built = buildOmnisendProduct(product({ doses: [] }), ORIGIN);
    expect(built.variants[0]).toMatchObject({ id: "bpc-157__default", price: 42.99, status: "inStock" });
  });

  it("goes across at 0 and notAvailable when the product price itself is unreadable", () => {
    const built = buildOmnisendProduct(product({ price: "" }), ORIGIN);
    expect(built.variants).toEqual([
      expect.objectContaining({ id: "bpc-157__default", price: 0, status: "notAvailable" }),
    ]);
  });
});

describe("categories", () => {
  it.each([
    ["Research Peptides", "research-peptides"],
    ["  Recon & Water  ", "recon-water"],
    ["GLP-1s", "glp-1s"],
    ["---Bacteriostatic Water---", "bacteriostatic-water"],
    ["", ""],
  ])("slugifies %j to %j", (input, expected) => {
    expect(slugifyCategory(input)).toBe(expected);
  });

  it("puts the slugified category in categoryIDs and the raw category in type", () => {
    const built = buildOmnisendProduct(product({ category: "Research Peptides" }), ORIGIN);
    expect(built.categoryIDs).toEqual(["research-peptides"]);
    expect(built.type).toBe("Research Peptides");
  });

  it("emits no categoryIDs for a product with no category", () => {
    const built = buildOmnisendProduct(product({ category: "" }), ORIGIN);
    expect(built.categoryIDs).toEqual([]);
    expect(built.type).toBeUndefined();
  });

  it("buildOmnisendCategories is unique by slug and keeps the first title seen", () => {
    const categories = buildOmnisendCategories([
      product({ slug: "a", category: "Research Peptides" }),
      product({ slug: "b", category: "research peptides" }),
      product({ slug: "c", category: "Recon Water" }),
      product({ slug: "d", category: "" }),
    ]);
    expect(categories).toEqual([
      { categoryID: "research-peptides", title: "Research Peptides" },
      { categoryID: "recon-water", title: "Recon Water" },
    ]);
  });
});

describe("a variant id Omnisend will actually accept", () => {
  // THE CHARSET, AS A TEST RATHER THAN AS A SURPRISE IN A BATCH RECORD.
  //
  // Omnisend validates a variant id against letters, numbers, underscores and
  // dashes. The separator here was "#", which is none of those, so the first
  // real catalogue push was refused for EVERY product — 34 of 34 on
  // 2026-09-17, each with `Variants[0].ID: must contain only letters, numbers,
  // underscores and dashes`. Nothing in the suite looked at the characters;
  // the tests asserted the exact strings the builder happened to produce, so
  // they agreed with the bug.
  //
  // A refused catalogue is not a cosmetic failure: abandoned cart, abandoned
  // checkout and browse abandonment all render product blocks, and a product
  // Omnisend does not hold renders nothing.
  const LEGAL = /^[A-Za-z0-9_-]+$/;

  it("uses only characters Omnisend allows", () => {
    expect(omnisendVariantId("bpc-157", "3dc8c066-b862-4057-9d47-66e6b9e5d0ce")).toMatch(LEGAL);
    expect(omnisendVariantId("bpc-157", "default")).toMatch(LEGAL);
  });

  it("every variant a real product emits passes, doses or not", () => {
    const withDoses = buildOmnisendProduct(
      product({ doses: [dose({ id: "d-5mg", label: "5mg" }), dose({ id: "d-10mg", label: "10mg" })] }),
      ORIGIN,
    );
    const withoutDoses = buildOmnisendProduct(product({ doses: [] }), ORIGIN);

    for (const built of [withDoses, withoutDoses]) {
      expect(built.variants.length).toBeGreaterThan(0);
      for (const variant of built.variants) {
        expect(variant.id, `${variant.id} is not a legal Omnisend variant id`).toMatch(LEGAL);
        expect(variant.id.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("keeps the product and its variant distinguishable", () => {
    // The separator has to survive round-tripping by eye: a cart line names
    // the variant, the catalogue holds it, and an operator reading a batch
    // error needs to see which product it belongs to.
    expect(omnisendVariantId("glp-1", "abc")).toBe("glp-1__abc");
  });
});
