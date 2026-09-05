import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// INV-04 — THE SOLD-OUT MESSAGE NAMES THE PRODUCT, NOT JUST THE DOSE.
//
// readAvailable answered `name: label` for a variant, so the losing buyer in a
// stock race read "5mg just sold out. Please adjust your cart and try again."
// A shopper with two 5mg lines cannot tell which one to fix. The product's name
// now rides along with the dose.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const state = vi.hoisted(() => ({
  doseRow: {
    inventory_quantity: 0,
    reserved_quantity: 0,
    label: "5mg",
    products: { name: "BPC-157" },
  } as Record<string, unknown>,
  selects: [] as string[],
}));

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({
      select: (columns: string) => {
        state.selects.push(columns);
        return { eq: () => ({ maybeSingle: async () => ({ data: state.doseRow, error: null }) }) };
      },
    }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  state.selects = [];
  state.doseRow = { inventory_quantity: 0, reserved_quantity: 0, label: "5mg", products: { name: "BPC-157" } };
});

async function loseTheRace() {
  rpc
    .mockResolvedValueOnce({ data: false, error: null }) // reserve_inventory: refused
    .mockResolvedValueOnce({ data: 0, error: null })     // expire_stale_reservations: nothing to reclaim
    .mockResolvedValueOnce({ data: 0, error: null });    // release_inventory_for_order
  const { reserveInventoryForOrder, describeUnavailable } = await import("@/lib/inventory-reservation");
  const result = await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::dose-5mg", quantity: 1 }]);
  return { result, message: describeUnavailable(result.unavailable) };
}

describe("a variant that sold out during checkout", () => {
  it("is named with its product: 'BPC-157 5mg', not '5mg'", async () => {
    const { result, message } = await loseTheRace();

    expect(result.ok).toBe(false);
    expect(result.unavailable[0]?.name).toBe("BPC-157 5mg");
    expect(message).toContain("BPC-157 5mg just sold out");
  });

  it("asks the database for the product name alongside the dose", async () => {
    await loseTheRace();
    expect(state.selects.some((columns) => /products\(name\)/.test(columns))).toBe(true);
  });

  it("copes with the join coming back as an array, as PostgREST sometimes shapes it", async () => {
    state.doseRow.products = [{ name: "GHK-Cu" }];
    state.doseRow.label = "50mg";
    const { result } = await loseTheRace();
    expect(result.unavailable[0]?.name).toBe("GHK-Cu 50mg");
  });

  it("falls back to the dose label alone when the product name is unavailable", async () => {
    state.doseRow.products = null;
    const { result } = await loseTheRace();
    expect(result.unavailable[0]?.name).toBe("5mg");
  });
});
