import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// VL-1 / DB-01 and VL-10 / INV-01 / F1 — THE CANCEL PATH, AGAINST THE REAL
// SHAPE OF THE DATABASE.
//
// Two defects live here, and the first hides the second.
//
// VL-1. `returnInventoryForCancelledOrder` asked PostgREST for
// `order_items(product_id, variant_id, quantity)`. THERE IS NO `variant_id`
// COLUMN ON `order_items` — verified against production on 2026-08-27, and
// against all four `create table public.order_items` statements in
// src/lib/sql/. The variant is encoded INSIDE `product_id` as
// `"<slug>::<dose-uuid>"`, which is exactly what `parseOrderItemRef` exists to
// split apart.
//
// PostgREST answers a select naming an absent column with 42703 — an ERROR, not
// a row with a null field. So `error` was always set, the function always took
// its "do not guess" branch, and EVERY cancellation returned `unavailable`.
// K-17's whole return path was inert: no cancel has ever put stock back.
//
// The existing tests could not see this. Their fake `select()` ignores the
// column list entirely and hands back the seeded row, so a select naming a
// column that does not exist looks identical to one that does. The fake below
// validates the projection the way PostgREST does, which is the only way this
// class of defect is visible from a unit test.
//
// VL-10. Fixing VL-1 UNMASKS a worse one. The signal the cancel path reads,
// `paid_side_effects_at`, is stamped by the card lane BEFORE the inventory
// decrement runs — it is that lane's exactly-once claim for ALL side effects,
// so it has to be taken first. It therefore does not mean "the units left the
// shelf"; it means "one webhook delivery won the right to try". Read as proof
// of the decrement, a cancel of an order whose decrement FAILED restocks units
// that were never removed: invented stock, which oversells. That is the exact
// direction this codebase's inventory rule forbids.
//
// The fix is a latch that means what the cancel path needs it to mean:
// `orders.inventory_committed_at`, written by both paid lanes only AFTER stock
// has actually moved.
// ---------------------------------------------------------------------------

// Verified against production (information_schema.columns, 2026-08-27), plus
// the new latch this change adds.
const ORDER_COLUMNS = new Set([
  "id", "order_id", "paid_side_effects_at", "inventory_restocked_at", "inventory_committed_at",
]);
const ORDER_ITEM_COLUMNS = new Set([
  "id", "order_id", "product_id", "product_name", "unit_price", "quantity", "line_total", "created_at",
]);

interface OrderRow {
  order_id: string;
  paid_side_effects_at: string | null;
  inventory_committed_at: string | null;
  inventory_restocked_at: string | null;
  order_items: Array<{ product_id: string; quantity: number }>;
}

const state: { order: OrderRow | null; restocked: Array<unknown[]>; released: string[]; alerts: string[] } = {
  order: null, restocked: [], released: [], alerts: [],
};

const { restockInventoryForOrder, releaseInventoryForOrder } = vi.hoisted(() => ({
  restockInventoryForOrder: vi.fn(async (items: unknown[]) => { state.restocked.push(items); }),
  releaseInventoryForOrder: vi.fn(async (orderId: string) => { state.released.push(orderId); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (a: { type: string }) => { state.alerts.push(a.type); }),
}));
vi.mock("@/lib/inventory-fulfillment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-fulfillment")>();
  return {
    ...actual,
    restockInventoryForOrder,
    claimInventoryRestock: vi.fn(async () => {
      const order = state.order;
      if (!order || order.inventory_restocked_at !== null) return "already_claimed";
      order.inventory_restocked_at = new Date().toISOString();
      return "claimed";
    }),
  };
});
vi.mock("@/lib/inventory-reservation", () => ({ releaseInventoryForOrder }));

/**
 * A select projection, checked the way PostgREST checks it.
 *
 * Returns the 42703 an unknown column really produces, so a query this codebase
 * cannot actually run fails the test instead of passing it.
 */
function project(columns: string): { data: unknown; error: { code: string; message: string } | null } {
  const nested = /order_items\(([^)]*)\)/.exec(columns);
  const top = columns.replace(/order_items\([^)]*\)/, "").split(",").map((c) => c.trim()).filter(Boolean);

  for (const column of top) {
    if (!ORDER_COLUMNS.has(column)) {
      return { data: null, error: { code: "42703", message: `column orders.${column} does not exist` } };
    }
  }
  const itemColumns = nested ? nested[1].split(",").map((c) => c.trim()).filter(Boolean) : [];
  for (const column of itemColumns) {
    if (!ORDER_ITEM_COLUMNS.has(column)) {
      return { data: null, error: { code: "42703", message: `column order_items.${column} does not exist` } };
    }
  }

  const order = state.order;
  if (!order) return { data: null, error: null };
  const row: Record<string, unknown> = {};
  for (const column of top) row[column] = (order as unknown as Record<string, unknown>)[column];
  if (nested) {
    row.order_items = order.order_items.map((item) => {
      const projected: Record<string, unknown> = {};
      for (const column of itemColumns) projected[column] = (item as unknown as Record<string, unknown>)[column];
      return projected;
    });
  }
  return { data: row, error: null };
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: (columns: string) => {
        const b: Record<string, unknown> = {
          eq() { return b; },
          async maybeSingle() { return project(columns); },
        };
        return b;
      },
    }),
  },
}));

function seed(overrides: Partial<OrderRow> = {}): void {
  state.order = {
    order_id: "ord-1",
    paid_side_effects_at: null,
    inventory_committed_at: null,
    inventory_restocked_at: null,
    order_items: [{ product_id: "bpc-157-10mg::dose-5mg", quantity: 2 }],
    ...overrides,
  };
}

beforeEach(() => {
  state.order = null; state.restocked = []; state.released = []; state.alerts = [];
  vi.clearAllMocks();
});

describe("VL-1 — the cancel path must query columns that exist", () => {
  it("RESTOCKS a committed order instead of erroring on a column that isn't there", async () => {
    const stamp = "2026-08-26T00:00:00.000Z";
    seed({ paid_side_effects_at: stamp, inventory_committed_at: stamp });
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(outcome.action).toBe("restocked");
    expect(state.restocked[0]).toEqual([{ product_id: "bpc-157-10mg::dose-5mg", quantity: 2 }]);
    expect(state.alerts).toEqual([]);
  });

  it("carries the variant through product_id, which is where it actually lives", async () => {
    const stamp = "2026-08-26T00:00:00.000Z";
    seed({ paid_side_effects_at: stamp, inventory_committed_at: stamp });
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");
    const { planInventoryAdjustments } = await import("@/lib/inventory-fulfillment");

    await returnInventoryForCancelledOrder("ord-1");

    // The restock plan still reaches the dose row, without a variant_id column.
    expect(planInventoryAdjustments(state.restocked[0] as never)).toEqual([
      { slug: "bpc-157-10mg", variantId: "dose-5mg", quantity: 2 },
    ]);
  });
});

describe("VL-10 — the latch must mean the stock moved, not that a lane claimed it", () => {
  it("does NOT restock when the paid claim was taken but the decrement failed", async () => {
    // The card lane stamps paid_side_effects_at first, then decrements. This is
    // the order whose decrement then failed: nothing left the shelf, so nothing
    // may come back. Restocking here would invent units.
    seed({ paid_side_effects_at: "2026-08-26T00:00:00.000Z", inventory_committed_at: null });
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    const outcome = await returnInventoryForCancelledOrder("ord-1");

    expect(state.restocked).toHaveLength(0);
    expect(outcome.action).toBe("released");
    expect(state.released).toEqual(["ord-1"]);
  });

  it("releases the still-active hold of an order that was never paid", async () => {
    seed();
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    expect((await returnInventoryForCancelledOrder("ord-1")).action).toBe("released");
    expect(state.restocked).toHaveLength(0);
  });

  it("still restocks exactly once across repeated cancels", async () => {
    const stamp = "2026-08-26T00:00:00.000Z";
    seed({ paid_side_effects_at: stamp, inventory_committed_at: stamp });
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");

    expect((await returnInventoryForCancelledOrder("ord-1")).action).toBe("restocked");
    expect((await returnInventoryForCancelledOrder("ord-1")).action).toBe("already_returned");
    expect(state.restocked).toHaveLength(1);
  });
});
