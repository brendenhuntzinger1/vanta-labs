import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// TWO INDEPENDENT GATES BETWEEN A MISSING PRICE AND A LOST SALE.
//
//   ADMIN     — refuses to PUBLISH a product with no price, so the owner finds
//               out while they are looking at the product, not from a customer.
//   CHECKOUT  — still refuses to sell one, whatever route the bad data took
//               into the database (a CSV import, a direct SQL edit, a restored
//               backup, a migration).
//
// The second is the one that protects the money and it is certified separately
// in commerce-journey.test.ts. This file certifies the first, and the point of
// having both is that neither is allowed to replace the other.
//
// `products.price_cents` is `integer not null default 0` and every write path
// coerces a missing price with `Math.max(0, Math.round(x ?? 0))`, so an unpriced
// product is the DEFAULT outcome of saving before the price is typed in — not
// an exotic one.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return harness.db.client; },
  createServerClient: () => harness.db.client,
}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));

function seedProduct(overrides: Record<string, unknown> = {}) {
  harness.db.seed("products", [{
    id: "prod-1",
    slug: "test-peptide",
    name: "Test Peptide",
    category: "Research Peptides",
    price_cents: 0,
    product_cost_cents: 0,
    inventory_quantity: 10,
    track_inventory: true,
    is_published: false,
    is_enabled: true,
    is_archived: false,
    ...overrides,
  }]);
}

beforeEach(() => {
  harness.reset();
});

describe("the price guard itself", () => {
  it("refuses zero, negative, blank and unparseable prices", async () => {
    const { assertPublishablePrice } = await import("@/lib/admin-products");
    for (const bad of [0, -1, "", null, undefined, Number.NaN, "TBD"]) {
      expect(() => assertPublishablePrice(bad, "Test Peptide")).toThrow(/no price/i);
    }
  });

  it("names the product, so the owner knows which one to fix", async () => {
    const { assertPublishablePrice } = await import("@/lib/admin-products");
    expect(() => assertPublishablePrice(0, "BPC-157 10mg")).toThrow(/BPC-157 10mg/);
  });

  it("accepts any real price, including one cent", async () => {
    const { assertPublishablePrice } = await import("@/lib/admin-products");
    expect(() => assertPublishablePrice(1)).not.toThrow();
    expect(() => assertPublishablePrice(4499)).not.toThrow();
  });
});

describe("publishing one product", () => {
  it("refuses to publish a product with no price, and does not write", async () => {
    seedProduct();
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await expect(updateAdminProduct("prod-1", { isPublished: true })).rejects.toThrow(/no price/i);

    // The gate is BEFORE the write: the product is still a draft.
    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(false);
  });

  it("publishes happily once a price exists", async () => {
    seedProduct({ price_cents: 4499 });
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await updateAdminProduct("prod-1", { isPublished: true });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(true);
  });

  it("accepts a price supplied in the same save that publishes it", async () => {
    seedProduct();
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await updateAdminProduct("prod-1", { isPublished: true, priceCents: 3999 });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(true);
  });

  it("does NOT block saving an unpriced DRAFT — that is normal work in progress", async () => {
    seedProduct();
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await updateAdminProduct("prod-1", { name: "Renamed while drafting" });

    expect(harness.db.findOne("products", "id", "prod-1")?.name).toBe("Renamed while drafting");
  });

  it("does NOT block unpublishing or archiving an unpriced product", async () => {
    seedProduct({ is_published: true });
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await updateAdminProduct("prod-1", { isPublished: false });
    await updateAdminProduct("prod-1", { isArchived: true });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_archived).toBe(true);
  });

  it("allows a DOSED product whose price lives on its doses", async () => {
    // replaceProductDoses copies the first dose's price onto the parent, so a
    // parent still reading 0 is priced. Blocking it would be a false alarm.
    seedProduct();
    harness.db.seed("product_doses", [
      { id: "dose-1", product_id: "prod-1", label: "10mg", price_cents: 5999, sale_price_cents: 0 },
    ]);
    const { updateAdminProduct } = await import("@/lib/admin-products");

    await updateAdminProduct("prod-1", { isPublished: true });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(true);
  });
});

describe("creating a product", () => {
  it("refuses to create it already published with no price", async () => {
    const { createAdminProduct } = await import("@/lib/admin-products");

    await expect(createAdminProduct({
      name: "Brand New Peptide",
      slug: "brand-new-peptide",
      category: "Research Peptides",
      isPublished: true,
    } as never)).rejects.toThrow(/no price/i);

    expect(harness.db.rows("products")).toHaveLength(0);
  });

  it("creates an unpriced DRAFT without complaint", async () => {
    const { createAdminProduct } = await import("@/lib/admin-products");

    await createAdminProduct({
      name: "Brand New Peptide",
      slug: "brand-new-peptide",
      category: "Research Peptides",
      isPublished: false,
    } as never);

    expect(harness.db.rows("products")).toHaveLength(1);
  });
});

describe("bulk publish", () => {
  it("refuses the WHOLE batch and names the offenders", async () => {
    seedProduct({ id: "prod-1", slug: "priced", name: "Priced One", price_cents: 4499 });
    harness.db.seed("products", [{
      id: "prod-2", slug: "unpriced", name: "Unpriced One", price_cents: 0,
      is_published: false, is_enabled: true, is_archived: false,
    }]);
    const { bulkUpdateAdminProducts } = await import("@/lib/admin-products");

    await expect(bulkUpdateAdminProducts({
      productIds: ["prod-1", "prod-2"],
      action: "publish",
    })).rejects.toThrow(/Unpriced One/);

    // Partial success would be worse than failure: it publishes some and
    // silently skips others, which reads as "it worked".
    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(false);
    expect(harness.db.findOne("products", "id", "prod-2")?.is_published).toBe(false);
  });

  it("publishes a fully-priced batch", async () => {
    seedProduct({ id: "prod-1", price_cents: 4499 });
    harness.db.seed("products", [{
      id: "prod-2", slug: "second", name: "Second", price_cents: 6999,
      is_published: false, is_enabled: true, is_archived: false,
    }]);
    const { bulkUpdateAdminProducts } = await import("@/lib/admin-products");

    await bulkUpdateAdminProducts({ productIds: ["prod-1", "prod-2"], action: "publish" });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(true);
    expect(harness.db.findOne("products", "id", "prod-2")?.is_published).toBe(true);
  });

  it("never blocks UNPUBLISHING an unpriced product", async () => {
    seedProduct({ is_published: true });
    const { bulkUpdateAdminProducts } = await import("@/lib/admin-products");

    await bulkUpdateAdminProducts({ productIds: ["prod-1"], action: "unpublish" });

    expect(harness.db.findOne("products", "id", "prod-1")?.is_published).toBe(false);
  });
});
