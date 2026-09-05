import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// INV-06 — THE LEDGER NAMES WHO RETURNED THE STOCK.
//
// applyInventoryDelta hard-coded actor "payment_webhook" for every movement, so
// an admin's cancel of a paid order was booked to the webhook. The restock now
// carries an actor, defaulting to the webhook (the only caller that never says).
// ---------------------------------------------------------------------------

const ledger = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>> }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: vi.fn() }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-ledger", () => ({
  recordInventoryTransaction: vi.fn(async (entry: Record<string, unknown>) => { ledger.entries.push(entry); }),
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { inventory_quantity: 6, product_id: "prod-1", id: "prod-1" }, error: null }) }),
      }),
    }),
  },
}));

const {
  restockInventoryForOrder,
  INVENTORY_ACTOR_ADMIN_CANCELLATION,
  INVENTORY_ACTOR_PAYMENT_WEBHOOK,
} = await import("@/lib/inventory-fulfillment");

beforeEach(() => {
  ledger.entries = [];
});

describe("restockInventoryForOrder", () => {
  it("books the movement to the actor it is given", async () => {
    await restockInventoryForOrder([{ productId: "bpc-157::dose-1", quantity: 2 }], "order-1", INVENTORY_ACTOR_ADMIN_CANCELLATION);

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ actor: "admin_cancellation", type: "order_canceled", delta: 2, orderId: "order-1" });
  });

  it("keeps the webhook attribution for the webhook, which passes none", async () => {
    await restockInventoryForOrder([{ productId: "bpc-157::dose-1", quantity: 1 }], "order-2");

    expect(ledger.entries[0]).toMatchObject({ actor: INVENTORY_ACTOR_PAYMENT_WEBHOOK });
    expect(INVENTORY_ACTOR_PAYMENT_WEBHOOK).toBe("payment_webhook");
  });
});
