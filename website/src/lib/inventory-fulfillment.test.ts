import { beforeEach, describe, expect, it, vi } from "vitest";

// decrementInventoryForOrder needs the RPC and the catalog cache; everything
// else in this file is pure.
const rpcFailures = { forSlugs: new Set<string>() };
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: vi.fn(async (_name: string, args: { p_slug: string }) => {
      void _name;
      return rpcFailures.forSlugs.has(args.p_slug)
        ? { data: null, error: { message: `adjust_inventory_on_sale failed for ${args.p_slug}` } }
        : { data: null, error: null };
    }),
  },
}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: vi.fn() }));

import { decrementInventoryForOrder, parseOrderItemRef, planInventoryAdjustments } from "./inventory-fulfillment";

describe("parseOrderItemRef", () => {
  it("splits a bare slug into slug + no variant", () => {
    expect(parseOrderItemRef("bpc-157-10mg")).toEqual({ slug: "bpc-157-10mg", variantId: null });
  });

  it("splits slug::variant into both parts", () => {
    expect(parseOrderItemRef("bpc-157-10mg::dose-uuid-1")).toEqual({
      slug: "bpc-157-10mg",
      variantId: "dose-uuid-1",
    });
  });

  it("treats an empty variant suffix as no variant", () => {
    expect(parseOrderItemRef("bpc-157-10mg::")).toEqual({ slug: "bpc-157-10mg", variantId: null });
  });
});

describe("planInventoryAdjustments", () => {
  it("maps each line to a positive quantity per product", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg", quantity: 2 },
      { productId: "tb-500::dose-a", quantity: 1 },
    ]);
    expect(plan).toEqual([
      { slug: "bpc-157-10mg", variantId: null, quantity: 2 },
      { slug: "tb-500", variantId: "dose-a", quantity: 1 },
    ]);
  });

  it("accepts raw snake_case order_items rows (regression: the webhook fallback passed product_id and silently no-opped)", () => {
    const plan = planInventoryAdjustments([
      { product_id: "bpc-157-10mg", quantity: 3 },
      { product_id: "tb-500::dose-a", quantity: 2 },
    ]);
    expect(plan).toEqual([
      { slug: "bpc-157-10mg", variantId: null, quantity: 3 },
      { slug: "tb-500", variantId: "dose-a", quantity: 2 },
    ]);
  });

  it("sums duplicate lines for the same product/variant into one adjustment", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg", quantity: 2 },
      { productId: "bpc-157-10mg", quantity: 3 },
    ]);
    expect(plan).toEqual([{ slug: "bpc-157-10mg", variantId: null, quantity: 5 }]);
  });

  it("keeps the same slug's distinct variants separate", () => {
    const plan = planInventoryAdjustments([
      { productId: "bpc-157-10mg::dose-a", quantity: 1 },
      { productId: "bpc-157-10mg::dose-b", quantity: 1 },
      { productId: "bpc-157-10mg", quantity: 1 },
    ]);
    expect(plan).toHaveLength(3);
  });

  it("drops lines with no product id or a non-positive quantity, truncating fractional counts", () => {
    const plan = planInventoryAdjustments([
      { productId: "", quantity: 5 },
      { productId: null, quantity: 5 },
      { productId: "x", quantity: 0 },
      { productId: "y", quantity: -3 },
      { productId: "z", quantity: 2.5 },
      { productId: "ok", quantity: 4 },
    ]);
    // 2.5 truncates to 2 (a real, shippable count); the rest are dropped.
    expect(plan).toEqual([
      { slug: "z", variantId: null, quantity: 2 },
      { slug: "ok", variantId: null, quantity: 4 },
    ]);
  });

  it("handles an empty or missing list", () => {
    expect(planInventoryAdjustments([])).toEqual([]);
    // @ts-expect-error — defensive against a nullish payload at runtime.
    expect(planInventoryAdjustments(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-12 — `failed: errors.length` AGAINST A LIST THAT STOPS GROWING AT FIVE.
//
// The operator alert and, worse, the caller's "did any of this move?" reasoning
// both read that number. Six or more failing lines reported five.
// ---------------------------------------------------------------------------
describe("decrementInventoryForOrder — the failure count", () => {
  beforeEach(() => {
    rpcFailures.forSlugs = new Set();
  });

  it("counts EVERY failing line, not just the ones it kept a message for", async () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ product_id: `slug-${index}`, quantity: 1 }));
    rpcFailures.forSlugs = new Set(items.map((item) => item.product_id));

    const result = await decrementInventoryForOrder(items);

    expect(result.attempted).toBe(7);
    expect(result.failed).toBe(7);
    // The message list is still capped, on purpose — an alert is not a log.
    expect(result.errors).toHaveLength(5);
  });

  it("reports a partial failure as partial", async () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ product_id: `slug-${index}`, quantity: 1 }));
    rpcFailures.forSlugs = new Set(["slug-3"]);

    const result = await decrementInventoryForOrder(items);

    expect(result).toMatchObject({ attempted: 4, failed: 1 });
  });

  it("reports a clean pass as clean", async () => {
    const result = await decrementInventoryForOrder([{ product_id: "slug-0", quantity: 2 }]);
    expect(result).toMatchObject({ attempted: 1, failed: 0, errors: [] });
  });
});
