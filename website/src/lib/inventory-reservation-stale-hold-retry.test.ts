import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN EXPIRED HOLD MUST NOT REFUSE A SALE.
//
// Availability is inventory_quantity minus reserved_quantity, and an expired
// hold stays in reserved_quantity until the half-hourly sweep reclaims it. So
// for up to ~30 minutes after a checkout was abandoned the product page said
// In Stock and the checkout refused "out of stock" over units nobody held.
// The reservation now reclaims stale holds itself on the first refusal and
// retries the line once.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { inventory_quantity: 5, reserved_quantity: 5, label: "10mg", name: "BPC-157" }, error: null }) }) }) }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
});

const LINE = [{ productId: "bpc-157-10mg::dose-10mg", quantity: 1 }];

describe("reserveInventoryForOrder when the shelf is held only by expired reservations", () => {
  it("reclaims stale holds and retries the line, so the sale goes through", async () => {
    rpc
      .mockResolvedValueOnce({ data: false, error: null })   // reserve_inventory: refused
      .mockResolvedValueOnce({ data: 2, error: null })       // expire_stale_reservations: 2 reclaimed
      .mockResolvedValueOnce({ data: true, error: null });   // reserve_inventory: now held
    const { reserveInventoryForOrder } = await import("@/lib/inventory-reservation");

    const result = await reserveInventoryForOrder("order-1", LINE);

    expect(result).toMatchObject({ ok: true, unavailable: [], degraded: false });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["reserve_inventory", "expire_stale_reservations", "reserve_inventory"]);
  });

  it("still refuses when nothing was stale — the units really are gone", async () => {
    rpc
      .mockResolvedValueOnce({ data: false, error: null })   // refused
      .mockResolvedValueOnce({ data: 0, error: null })       // nothing to reclaim
      .mockResolvedValueOnce({ data: 0, error: null });      // release_inventory_for_order
    const { reserveInventoryForOrder } = await import("@/lib/inventory-reservation");

    const result = await reserveInventoryForOrder("order-2", LINE);

    expect(result.ok).toBe(false);
    expect(result.unavailable).toHaveLength(1);
    // Refused, reclaimed nothing, no second attempt.
    expect(rpc.mock.calls.slice(0, 2).map((c) => c[0])).toEqual(["reserve_inventory", "expire_stale_reservations"]);
    expect(rpc.mock.calls.filter((c) => c[0] === "reserve_inventory")).toHaveLength(1);
  });

  it("reclaims at most once per order, however many lines are refused", async () => {
    rpc
      .mockResolvedValueOnce({ data: false, error: null })   // line 1 refused
      .mockResolvedValueOnce({ data: 1, error: null })       // reclaim
      .mockResolvedValueOnce({ data: false, error: null })   // line 1 still refused
      .mockResolvedValueOnce({ data: false, error: null })   // line 2 refused, no second reclaim
      .mockResolvedValue({ data: 0, error: null });          // release
    const { reserveInventoryForOrder } = await import("@/lib/inventory-reservation");

    await reserveInventoryForOrder("order-3", [...LINE, { productId: "ghk-cu", quantity: 1 }]);

    expect(rpc.mock.calls.filter((c) => c[0] === "expire_stale_reservations")).toHaveLength(1);
  });
});
