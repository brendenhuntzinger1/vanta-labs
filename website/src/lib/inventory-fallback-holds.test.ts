import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A LATE PAYMENT MUST NOT TAKE ANOTHER CHECKOUT'S UNITS.
//
// The fallback decrement (adjust_inventory_on_sale) checks only that the
// on-hand count stays >= 0. It knows nothing about reserved_quantity, so an
// order whose own hold had expired before the customer paid could sell the
// last unit out from under a checkout that was still holding it; that order's
// finalize then clamped at zero and reported success. Two paid orders, one
// vial. The decrement now refuses a line when the units are held by OTHER
// orders, alerts the operator, and leaves the count alone.
// ---------------------------------------------------------------------------

const state = {
  row: { inventory_quantity: 1, reserved_quantity: 1 } as { inventory_quantity: number; reserved_quantity: number } | null,
  rowError: null as Error | null,
  ownHolds: [] as Array<{ quantity: number }>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  alerts: [] as Array<Record<string, unknown>>,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/inventory-ledger", () => ({ recordInventoryTransaction: async () => {} }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: Record<string, unknown>) => { state.alerts.push(alert); },
}));
vi.mock("@/lib/supabase-server", () => {
  const rowBuilder = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: state.rowError ? null : state.row, error: state.rowError });
    return b;
  };
  const holdsBuilder = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: state.ownHolds, error: null }).then(resolve);
    return b;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => (table === "inventory_reservations" ? holdsBuilder() : rowBuilder()),
      rpc: async (name: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ name, ...args });
        return { data: true, error: null };
      },
    },
  };
});

import { decrementInventoryForOrder } from "@/lib/inventory-fulfillment";

beforeEach(() => {
  state.row = { inventory_quantity: 1, reserved_quantity: 1 };
  state.rowError = null;
  state.ownHolds = [];
  state.rpcCalls = [];
  state.alerts = [];
});

const LINE = [{ productId: "bpc-157-10mg::dose-10mg", quantity: 1 }];

describe("decrementInventoryForOrder against active holds", () => {
  it("refuses to take a unit that another checkout is holding, and says so", async () => {
    const result = await decrementInventoryForOrder(LINE, "order-late-payer");
    expect(state.rpcCalls).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatch(/held by other checkouts/);
    expect(state.alerts.map((a) => a.type)).toEqual(["inventory_units_held_by_other_orders"]);
    expect(state.alerts[0].severity).toBe("critical");
    expect(state.alerts[0].context).toMatchObject({ orderId: "order-late-payer", quantity: 1, free: 0, heldByOthers: 1 });
  });

  it("counts this order's OWN still-active hold as free (a degraded finalize leaves it in place)", async () => {
    state.ownHolds = [{ quantity: 1 }];
    const result = await decrementInventoryForOrder(LINE, "order-degraded-finalize");
    expect(result.failed).toBe(0);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({ name: "adjust_inventory_on_sale", p_qty: -1 });
    expect(state.alerts).toHaveLength(0);
  });

  it("sells normally when nobody else holds anything", async () => {
    state.row = { inventory_quantity: 3, reserved_quantity: 0 };
    const result = await decrementInventoryForOrder(LINE, "order-plain");
    expect(result.failed).toBe(0);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("sells when enough units remain after other checkouts' holds", async () => {
    state.row = { inventory_quantity: 5, reserved_quantity: 2 };
    const result = await decrementInventoryForOrder([{ productId: "bpc-157-10mg::dose-10mg", quantity: 3 }], "order-fits");
    expect(result.failed).toBe(0);
    expect(state.rpcCalls[0]).toMatchObject({ p_qty: -3 });
  });

  it("keeps today's behaviour when the availability read fails (a read must not decide a sale)", async () => {
    state.rowError = new Error("connection reset");
    const result = await decrementInventoryForOrder(LINE, "order-read-failed");
    expect(result.failed).toBe(0);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.alerts).toHaveLength(0);
  });
});
