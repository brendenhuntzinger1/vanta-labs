import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-17. CANCELLING AN ORDER MUST NOT DESTROY, DUPLICATE, OR INVENT STOCK.
//
// THE INTENDED BEHAVIOUR, established from the codebase's own statements rather
// than assumed:
//
//   1. restockInventoryForOrder's docblock (inventory-fulfillment.ts:118-120):
//      "Return stock when a paid order is fully refunded OR CANCELED — the exact
//       inverse of the decrement above, so tracked stock nets back to where it
//       began." The intent for cancel was already written down; it simply had no
//      caller.
//
//   2. The admin REFUND path's long comment (api/admin/orders/[orderId]:425-441)
//      explains why a REFUND must not restock — a returned vial may have spent a
//      week in a mailbox — and then names the opposite case explicitly: "an order
//      the customer never received (a failed or cancelled order whose goods never
//      left), which is a different situation."
//
//   3. FULFILLMENT_TRANSITIONS reaches `cancelled` only from awaiting_payment,
//      paid, ready_to_fulfill and packed, with the stated rule "No cancel after
//      shipping: the goods are gone." So a cancel is pre-carrier by construction.
//
//   4. The published Return & Reimbursement Policy tells customers "we can
//      usually cancel an order before it has been packed and a shipping label has
//      been purchased."
//
// So: a cancel means the goods never left, and the stock must come back — EXACTLY
// ONCE, and only if it actually went out.
//
// The third clause is the subtle one and is what "duplicated" and "incorrectly
// restored" mean here. An order cancelled from awaiting_payment was never
// decremented — its reservation is still `active` and merely holds stock. Calling
// restock on it would ADD units that were never removed: phantom stock, which
// oversells. That order needs its RESERVATION RELEASED, not a restock.
//
// The signal for which happened is orders.paid_side_effects_at, the latch under
// which the paid side effects (including the inventory decrement) run.
// ---------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  paid_side_effects_at: string | null;
  inventory_restocked_at: string | null;
  order_items: Array<{ product_id: string; variant_id: string | null; quantity: number }>;
}

const state: { orders: OrderRow[]; restocked: Array<unknown[]>; released: string[] } = {
  orders: [], restocked: [], released: [],
};

const { restockInventoryForOrder, releaseInventoryForOrder } = vi.hoisted(() => ({
  restockInventoryForOrder: vi.fn(async (items: unknown[]) => { state.restocked.push(items); }),
  releaseInventoryForOrder: vi.fn(async (orderId: string) => { state.released.push(orderId); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-fulfillment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inventory-fulfillment")>("@/lib/inventory-fulfillment");
  return {
    ...actual,
    restockInventoryForOrder,
    // The real claim is a conditional UPDATE on inventory_restocked_at NULL->now.
    // Reproduce that semantic exactly: the claim is what makes restock
    // exactly-once, so a stub that always returns true would hide the defect.
    claimInventoryRestock: vi.fn(async (orderId: string) => {
      const order = state.orders.find((o) => o.order_id === orderId);
      if (!order || order.inventory_restocked_at !== null) return "already_claimed";
      order.inventory_restocked_at = new Date().toISOString();
      return "claimed";
    }),
  };
});
vi.mock("@/lib/inventory-reservation", () => ({ releaseInventoryForOrder }));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { filters.push([c, v]); return b; },
          async maybeSingle() {
            const found = state.orders.find((o) => filters.every(([c, v]) => String((o as unknown as Record<string, unknown>)[c]) === String(v)));
            return { data: found ? { ...found } : null, error: null };
          },
        };
        return b;
      },
    }),
  },
}));

function seedOrder(paid: boolean): OrderRow {
  const order: OrderRow = {
    order_id: "ord-1",
    paid_side_effects_at: paid ? new Date().toISOString() : null,
    inventory_restocked_at: null,
    order_items: [{ product_id: "bpc-157", variant_id: "dose-5mg", quantity: 2 }],
  };
  state.orders.push(order);
  return order;
}

beforeEach(() => {
  state.orders = []; state.restocked = []; state.released = [];
  vi.clearAllMocks();
});

describe("returnInventoryForCancelledOrder", () => {
  it("RESTOCKS a paid order — the goods never left, so the stock comes back", async () => {
    seedOrder(true);
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(outcome.action).toBe("restocked");
    expect(state.restocked).toHaveLength(1);
    expect(state.restocked[0]).toEqual([{ product_id: "bpc-157", variant_id: "dose-5mg", quantity: 2 }]);
    expect(state.released).toHaveLength(0);
  });

  it("restocks EXACTLY ONCE, so a repeated cancel cannot duplicate stock", async () => {
    seedOrder(true);
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const first = await returnInventoryForCancelledOrder("ord-1");
    const second = await returnInventoryForCancelledOrder("ord-1");

    expect(first.action).toBe("restocked");
    expect(second.action).toBe("already_returned");
    expect(state.restocked).toHaveLength(1);
  });

  it("does not restock behind a refund that already claimed it", async () => {
    // payment-webhook's refund path restocks behind the same claim. Whichever
    // runs first wins; the other must be a no-op. This is what stops a cancel
    // followed by a processor refund from returning the stock twice.
    const order = seedOrder(true);
    order.inventory_restocked_at = new Date().toISOString();
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(outcome.action).toBe("already_returned");
    expect(state.restocked).toHaveLength(0);
  });

  it("RELEASES the reservation for an unpaid order instead of restocking", async () => {
    // The decrement never ran, so restocking would invent units that were never
    // removed. The hold is what needs returning.
    seedOrder(false);
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(outcome.action).toBe("released");
    expect(state.released).toEqual(["ord-1"]);
    expect(state.restocked).toHaveLength(0);
  });

  it("never restocks an unpaid order however many times it is cancelled", async () => {
    seedOrder(false);
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    await returnInventoryForCancelledOrder("ord-1");
    await returnInventoryForCancelledOrder("ord-1");

    expect(state.restocked).toHaveLength(0);
    expect(state.released).toEqual(["ord-1", "ord-1"]);
  });

  it("does nothing, and says so, for an order that does not exist", async () => {
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");
    const outcome = await returnInventoryForCancelledOrder("nope");
    expect(outcome.action).toBe("order_not_found");
    expect(state.restocked).toHaveLength(0);
    expect(state.released).toHaveLength(0);
  });

  it("does not restock an order with no line items", async () => {
    const order = seedOrder(true);
    order.order_items = [];
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(outcome.action).toBe("no_items");
    expect(state.restocked).toHaveLength(0);
  });
});

describe("the admin cancel action calls it", () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("node:fs") as typeof import("node:fs")).readFileSync(p, "utf8");

  it("wires the return into the cancel branch, after the transition succeeds", () => {
    const source = read("src/app/api/admin/orders/[orderId]/route.ts");
    expect(source).toContain("returnInventoryForCancelledOrder");
    // It must run only once the pipeline has ACCEPTED the transition — the
    // pipeline is what refuses a cancel after shipping, and returning stock for a
    // refused cancel would invent it.
    const guard = source.indexOf("if (!cancelled.ok)");
    const call = source.indexOf("returnInventoryForCancelledOrder(orderId)");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });
});
