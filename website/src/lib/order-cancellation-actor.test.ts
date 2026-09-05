import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// INV-06 — an admin cancel restocks as the admin cancel path, not the webhook.
//
// returnInventoryForCancelledOrder is reached only from setOrderFulfillmentStatus
// (the order route's cancel action and the bulk action), and passed no actor, so
// the ledger read "payment_webhook" for a human's click.
// ---------------------------------------------------------------------------

const restock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { void _args; }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-reservation", () => ({ releaseInventoryForOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-fulfillment", () => ({
  claimInventoryRestock: vi.fn(async () => "claimed"),
  restockInventoryForOrder: restock,
  INVENTORY_ACTOR_ADMIN_CANCELLATION: "admin_cancellation",
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              order_id: "order-9",
              inventory_committed_at: "2026-09-01T00:00:00.000Z",
              order_items: [{ product_id: "bpc-157::dose-1", quantity: 1 }],
            },
            error: null,
          }),
        }),
      }),
    }),
  },
}));

const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

beforeEach(() => {
  restock.mockClear();
});

describe("returnInventoryForCancelledOrder", () => {
  it("restocks as the admin cancel path by default", async () => {
    const outcome = await returnInventoryForCancelledOrder("order-9");

    expect(outcome).toEqual({ action: "restocked" });
    expect(restock).toHaveBeenCalledWith(
      [{ product_id: "bpc-157::dose-1", quantity: 1 }],
      "order-9",
      "admin_cancellation",
    );
  });

  it("lets a caller name a different actor", async () => {
    await returnInventoryForCancelledOrder("order-9", { actor: "bulk_cancel:owner" });
    expect(restock.mock.calls[0]?.[2]).toBe("bulk_cancel:owner");
  });
});
