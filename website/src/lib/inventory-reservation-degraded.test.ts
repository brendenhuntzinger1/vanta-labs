import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT THE RESERVATION MODULE DOES WHEN THE DATABASE WILL NOT ANSWER.
//
// src/lib/inventory-reservation.ts is the code that actually calls the SQL RPCs.
// The file named after it — inventory-reservation.test.ts — imports
// InventoryReservationModel instead, a hand-written in-memory mirror whose own
// header admits it is "a pure, in-memory mirror of the inventory-reservations
// SQL RPCs". The real module is never imported by it, so none of its fail-open
// paths had a test.
//
// A sabotage sweep found one that nothing catches. Changing finalize's catch to
//
//     catch { return { finalized: 1, degraded: false }; }
//
// leaves all 3,663 tests green. That return value is a phantom success: the
// caller's guard is `if (fin.degraded || fin.finalized === 0)`, so a broken RPC
// reports "one line deducted, everything fine", the legacy decrement is
// suppressed, and a paid order takes NOTHING off the shelf. The next shopper
// buys stock that is already gone.
//
// The fail-open behaviour here is deliberate and correct — an RPC outage must
// not block a real customer at checkout. What matters is that it fails open
// while TELLING THE CALLER, because the caller has a fallback and only runs it
// when it is told to.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  },
}));

async function mod() {
  return import("@/lib/inventory-reservation");
}

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
});

describe("finalize tells the caller when it could not do the job", () => {
  it("reports what it deducted when the RPC works", async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    const { finalizeInventoryForOrder } = await mod();

    expect(await finalizeInventoryForOrder("order-1")).toEqual({ finalized: 3, degraded: false });
  });

  it("reports DEGRADED when the RPC returns an error", async () => {
    // The caller runs the legacy decrement on exactly this signal. Report
    // success here and a paid order silently ships nothing off the shelf.
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const { finalizeInventoryForOrder } = await mod();

    expect(await finalizeInventoryForOrder("order-1")).toEqual({ finalized: 0, degraded: true });
  });

  it("reports DEGRADED when the call throws", async () => {
    rpc.mockRejectedValue(new Error("connection reset"));
    const { finalizeInventoryForOrder } = await mod();

    expect(await finalizeInventoryForOrder("order-1")).toEqual({ finalized: 0, degraded: true });
  });

  it("never claims to have deducted a line it did not deduct", async () => {
    // The property that matters, stated directly: on any unhappy path the
    // result must trip `fin.degraded || fin.finalized === 0`.
    const unhappy = [
      { data: null, error: { message: "boom" } },
      { data: undefined, error: { message: "boom" } },
      { data: 0, error: null },
      { data: null, error: null },
    ];
    const { finalizeInventoryForOrder } = await mod();
    for (const outcome of unhappy) {
      rpc.mockResolvedValueOnce(outcome);
      const result = await finalizeInventoryForOrder("order-1");
      expect(result.degraded || result.finalized === 0).toBe(true);
    }
  });
});

describe("reserve fails OPEN, but only on a genuine outage", () => {
  it("refuses a line the database says is out of stock", async () => {
    // A strict `false` is the oversell guard. Widening that comparison — to
    // `data === null`, say — makes the guard dead while every existing test
    // stays green, because the only suite named after this module tests a
    // hand-written mirror instead.
    rpc.mockResolvedValue({ data: false, error: null });
    const { reserveInventoryForOrder } = await mod();

    const result = await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::v1", quantity: 2 }]);

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.unavailable).toHaveLength(1);
  });

  it("allows the line when the database says yes", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { reserveInventoryForOrder } = await mod();

    expect(await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::v1", quantity: 2 }]))
      .toEqual({ ok: true, unavailable: [], degraded: false });
  });

  it("allows the line, marked degraded, when the RPC is not installed", async () => {
    // `null` is what an environment without the migration returns. Treating it
    // as "out of stock" would refuse every order in that environment.
    rpc.mockResolvedValue({ data: null, error: null });
    const { reserveInventoryForOrder } = await mod();

    expect(await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::v1", quantity: 2 }]))
      .toEqual({ ok: true, unavailable: [], degraded: false });
  });

  it("lets a real customer through when the database errors, and says it was degraded", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });
    const { reserveInventoryForOrder } = await mod();

    expect(await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::v1", quantity: 2 }]))
      .toEqual({ ok: true, unavailable: [], degraded: true });
  });

  it("lets a real customer through when the call throws, and says it was degraded", async () => {
    rpc.mockRejectedValue(new Error("connection reset"));
    const { reserveInventoryForOrder } = await mod();

    expect(await reserveInventoryForOrder("order-1", [{ productId: "bpc-157::v1", quantity: 2 }]))
      .toEqual({ ok: true, unavailable: [], degraded: true });
  });
});

describe("the sweep that returns abandoned holds to the shelf", () => {
  it("reports how many it reclaimed", async () => {
    rpc.mockResolvedValue({ data: 7, error: null });
    const { expireStaleReservations } = await mod();
    expect(await expireStaleReservations()).toBe(7);
  });

  it("reclaims nothing rather than throwing when the RPC fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { expireStaleReservations } = await mod();
    expect(await expireStaleReservations()).toBe(0);
  });

  it("never blocks its caller when the release RPC throws", async () => {
    rpc.mockRejectedValue(new Error("connection reset"));
    const { releaseInventoryForOrder } = await mod();
    await expect(releaseInventoryForOrder("order-1")).resolves.toBeUndefined();
  });
});
