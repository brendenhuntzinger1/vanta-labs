import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-13 — AN INVENTORY RPC THAT FAILS MUST NOT LOOK LIKE ONE THAT DID NOTHING.
//
// Every failure in this module was absorbed into a return value:
//
//   finalizeInventoryForOrder  -> { finalized: 0, degraded: true }, no log.
//                                 The caller's fallback then calls
//                                 adjust_inventory_on_sale, which does not exist
//                                 in production (G-04) and swallows its own
//                                 error too — so a broken paid-path stock
//                                 movement was invisible end to end.
//
//   expireStaleReservations    -> 0, which is indistinguishable from "nothing
//                                 was due". The sweep reports a clean run while
//                                 every expired hold stays on the shelf and the
//                                 units stay unsellable.
//
//   releaseInventoryForOrder   -> console.error only.
//
// The degradation is KEPT. A paid order must never be stranded by an inventory
// RPC, and that is a deliberate posture, not an oversight. What changed is that
// it stops being silent — the same trade the rate limiter makes in K-15.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  fail: null as null | { message: string },
  throwInstead: false,
  data: 0 as number,
  alerts: [] as Array<{ type: string; severity: string; context: Record<string, unknown> }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (a: { type: string; severity: string; context: Record<string, unknown> }) => {
    store.alerts.push({ type: a.type, severity: a.severity, context: a.context });
  },
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (store.throwInstead) throw new Error("connection reset");
      if (store.fail) return { data: null, error: store.fail };
      return { data: store.data, error: null };
    },
  },
}));

const {
  finalizeInventoryForOrder,
  releaseInventoryForOrder,
  expireStaleReservations,
  __resetInventoryAlertThrottle,
} = await import("@/lib/inventory-reservation");

beforeEach(() => {
  store.fail = null;
  store.throwInstead = false;
  store.data = 0;
  store.alerts = [];
  __resetInventoryAlertThrottle();
});

describe("finalize", () => {
  it("reports the lines it moved on the happy path, and raises nothing", async () => {
    store.data = 3;

    expect(await finalizeInventoryForOrder("order-1")).toEqual({ finalized: 3, degraded: false });
    expect(store.alerts).toHaveLength(0);
  });

  it("still degrades rather than stranding a paid order", async () => {
    store.fail = { message: 'function finalize_inventory_for_order does not exist' };

    // The posture is deliberate and is kept.
    expect(await finalizeInventoryForOrder("order-1")).toEqual({ finalized: 0, degraded: true });
  });

  it("raises a critical alert instead of degrading in silence", async () => {
    store.fail = { message: 'function finalize_inventory_for_order does not exist' };

    await finalizeInventoryForOrder("order-1");

    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]).toMatchObject({ type: "inventory_rpc_failed", severity: "critical" });
    expect(store.alerts[0].context).toMatchObject({ rpc: "finalize_inventory_for_order", orderId: "order-1" });
  });

  it("raises it when the client throws outright, not only on a returned error", async () => {
    store.throwInstead = true;

    expect(await finalizeInventoryForOrder("order-2")).toEqual({ finalized: 0, degraded: true });
    expect(store.alerts).toHaveLength(1);
  });
});

describe("the expiry sweep", () => {
  it("returns the count it reclaimed, and raises nothing", async () => {
    store.data = 7;

    expect(await expireStaleReservations()).toBe(7);
    expect(store.alerts).toHaveLength(0);
  });

  /**
   * THE DANGEROUS ONE. 0 means "nothing was due" AND "the RPC failed", so a
   * broken sweep reported a clean run for ever while holds piled up.
   */
  it("still returns 0 on failure, but says so", async () => {
    store.fail = { message: "permission denied for function expire_stale_reservations" };

    expect(await expireStaleReservations()).toBe(0);
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0].context).toMatchObject({ rpc: "expire_stale_reservations" });
  });

  it("a genuine zero is NOT an alert", async () => {
    store.data = 0;

    expect(await expireStaleReservations()).toBe(0);
    expect(store.alerts).toHaveLength(0);
  });
});

describe("release", () => {
  it("raises when a hold cannot be released", async () => {
    store.throwInstead = true;

    await releaseInventoryForOrder("order-3");

    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0].context).toMatchObject({ rpc: "release_inventory_for_order", orderId: "order-3" });
  });
});

describe("the alarm is not buried", () => {
  it("throttles per RPC — an outage hits every order at once", async () => {
    store.fail = { message: "down" };

    for (let i = 0; i < 20; i += 1) await finalizeInventoryForOrder(`order-${i}`);

    expect(store.alerts).toHaveLength(1);
  });

  it("but a DIFFERENT rpc failing still gets its own alarm", async () => {
    store.fail = { message: "down" };

    await finalizeInventoryForOrder("order-1");
    await expireStaleReservations();

    expect(store.alerts.map((a) => a.context.rpc)).toEqual([
      "finalize_inventory_for_order",
      "expire_stale_reservations",
    ]);
  });
});
