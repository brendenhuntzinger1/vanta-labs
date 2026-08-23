import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A REFUNDED ORDER RETURNS ITS STOCK EXACTLY ONCE.
//
// claimInventoryRestock is the one thing standing between "cancel/refund puts
// the units back" and "cancel/refund puts the units back TWICE". A double
// restock inflates tracked stock above what physically exists, and the store
// then sells inventory it does not have -- an oversell the owner only
// discovers at the packing table.
//
// The claim is an atomic conditional UPDATE: it stamps inventory_restocked_at
// only where that column IS NULL, and reports whether it won. Two concurrent
// refund handlers therefore see exactly one true.
//
// WHY THIS FILE EXISTS
//
// Making the claim return true unconditionally -- so every retry, duplicate
// webhook and double-click restocks again -- left all 2,662 existing tests
// green. Nothing proved the guard.
// ---------------------------------------------------------------------------

const state: {
  restockedAt: string | null;
  calls: Array<{ filterNull: boolean; orderId: string }>;
  failNext: boolean;
} = { restockedAt: null, calls: [], failNext: false };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table !== "orders") {
      return { update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [], error: null }) }) }) }) };
    }
    return {
      update: () => {
        let orderId = "";
        let sawNullFilter = false;
        const builder: Record<string, unknown> = {
          eq(_column: string, value: string) {
            orderId = value;
            return builder;
          },
          is(_column: string, value: unknown) {
            // The claim is only atomic BECAUSE of this filter.
            sawNullFilter = value === null;
            return builder;
          },
          async select() {
            state.calls.push({ filterNull: sawNullFilter, orderId });
            if (state.failNext) {
              state.failNext = false;
              return { data: null, error: { message: "connection lost" } };
            }
            // Models the real conditional update: rows come back only when the
            // WHERE actually matched. A second attempt matches nothing.
            if (sawNullFilter && state.restockedAt !== null) {
              return { data: [], error: null };
            }
            state.restockedAt = new Date().toISOString();
            return { data: [{ id: "row-1" }], error: null };
          },
        };
        return builder;
      },
    };
  };
  return { supabaseAdmin: { from } };
});

async function claim(orderId: string) {
  const { claimInventoryRestock } = await import("@/lib/inventory-fulfillment");
  return claimInventoryRestock(orderId);
}

beforeEach(() => {
  state.restockedAt = null;
  state.calls = [];
  state.failNext = false;
});

describe("claiming the right to restock an order", () => {
  it("grants the claim the first time", async () => {
    expect(await claim("order-1")).toBe(true);
  });

  it("REFUSES every later attempt, so stock is returned once", async () => {
    expect(await claim("order-1")).toBe(true);
    expect(await claim("order-1")).toBe(false);
    expect(await claim("order-1")).toBe(false);
  });

  it("gives exactly one winner when handlers race", async () => {
    // A duplicate refund webhook, a retry and an owner double-click all
    // arriving together.
    const results = await Promise.all([claim("order-1"), claim("order-1"), claim("order-1")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("claims conditionally on the column still being NULL", async () => {
    await claim("order-1");
    // Without this filter the update is not atomic and the race above is lost.
    expect(state.calls[0]?.filterNull).toBe(true);
  });

  it("claims for the order it was asked about", async () => {
    await claim("order-abc");
    expect(state.calls[0]?.orderId).toBe("order-abc");
  });

  describe("when the database call fails", () => {
    it("REFUSES the claim rather than assuming it won", async () => {
      state.failNext = true;
      // Under-restock is recoverable; double-restock is a money-losing
      // oversell. The safe failure direction is "do not restock".
      expect(await claim("order-1")).toBe(false);
    });

    it("still allows a genuine claim afterwards", async () => {
      state.failNext = true;
      expect(await claim("order-1")).toBe(false);
      expect(await claim("order-1")).toBe(true);
    });
  });
});
