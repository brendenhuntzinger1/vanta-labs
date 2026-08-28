import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// FOUND BY THE CROSS-MODULE ASSUMPTION SWEEP — the same K-17 stock write-off,
// through two buttons nobody wired up.
//
// order-cancellation-inventory.ts closes with an instruction for staying correct:
//
//   "Any future path that cancels an order must call this. The pipeline is the
//    only writer of the `cancelled` transition, so that is the place to look
//    for callers."
//
// Both halves are false, and the second is what made the first unenforceable.
// `order-pipeline.ts` writes NOTHING — its own header says "Everything here is
// PURE: no database, no network, no clock". It is a decision table. The actual
// writer is `setOrderFulfillmentStatus` (shippo/service.ts), and it has THREE
// callers that can pass `cancelled`:
//
//   api/admin/orders/[orderId]/route.ts  action "cancel"         RESTOCKS
//   api/admin/orders/[orderId]/route.ts  action "update_status"  did NOT
//   lib/admin-orders.ts                  bulk "cancel"           did NOT
//
// admin-orders.ts does not import order-cancellation-inventory at all. So
// bulk-cancelling paid orders permanently wrote off their units — the exact loss
// K-17 exists to prevent, reproduced through a different button. And the
// single-order screen has BOTH: a "Cancel" button that restocked and a
// "Cancelled" option in the status dropdown one row over that did not, with no
// visible difference to the operator.
//
// THE FIX IS THE CHOKEPOINT, NOT A FOURTH CALL SITE. The restock now lives in
// setOrderFulfillmentStatus, which is the sole writer, so every present and
// future cancel path inherits it.
//
// SECOND DEFECT, same comment: "FULFILLMENT_TRANSITIONS reaches `cancelled` only
// from awaiting_payment, paid, ready_to_fulfill and packed — every one
// pre-carrier". False. `label_purchased` also carries a `cancelled` edge
// (order-pipeline.ts:271-280), and the app knows it — fulfillment-workstation
// renders a dedicated "cancelled orders with a purchased label" queue. Cancelling
// from there and restocking would INVENT units whose parcel may already be with
// the carrier, which is the failure the same docblock claims to prevent.
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  order_id: string;
  fulfillment_status: string;
  payment_status: string;
  paid_side_effects_at: string | null;
  inventory_restocked_at: string | null;
  [key: string]: unknown;
}

const db: {
  order: OrderRow;
  restocked: Array<unknown[]>;
  released: string[];
  alerts: Array<{ type: string; message: string }>;
} = { order: {} as OrderRow, restocked: [], released: [], alerts: [] };

function freshOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "row-1",
    order_id: "ord-cancel-1",
    order_number: "VL-CX1",
    fulfillment_status: "paid",
    payment_status: "paid",
    // Paid side effects ran, so the units ARE decremented and must come back.
    paid_side_effects_at: "2026-08-26T00:00:00.000Z",
    inventory_restocked_at: null,
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    tracking_number: null,
    carrier: null,
    // Production's order_items has NO variant_id column. The variant travels
    // inside product_id as `slug::variantId` (parseOrderItemRef). This fixture
    // used to invent the column, so the suite proved the reader worked against
    // a schema production does not have — while the real embedded select was
    // failing 42703 in production and restocking nothing.
    order_items: [{ product_id: "bpc-157::dose-5mg", quantity: 4 }],
    ...overrides,
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: { type: string; message: string }) => { db.alerts.push(alert); }),
}));
vi.mock("@/lib/inventory-fulfillment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-fulfillment")>();
  return {
    ...actual,
    restockInventoryForOrder: vi.fn(async (items: unknown[]) => { db.restocked.push(items); }),
  };
});
vi.mock("@/lib/inventory-reservation", () => ({
  releaseInventoryForOrder: vi.fn(async (orderId: string) => { db.released.push(orderId); }),
  finalizeInventoryForOrder: vi.fn(async () => ({ finalized: 1, degraded: false })),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/templates", () => ({
  shippingUpdateTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  const ordersTable = () => ({
    select: (columns?: string) => {
      const nested = /order_items\(([^)]*)\)/.exec(columns ?? "");
      const project = (row: OrderRow) => {
        if (!nested) return { ...row };
        const keep = nested[1].split(",").map((c) => c.trim()).filter(Boolean);
        return {
          ...row,
          order_items: (row.order_items as Array<Record<string, unknown>>).map((item) =>
            Object.fromEntries(keep.map((column) => [column, item[column]]))),
        };
      };
      const b: Record<string, unknown> = {
        eq: () => b,
        in: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: project(db.order), error: null }),
        single: async () => ({ data: project(db.order), error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [project(db.order)], error: null }).then(resolve),
      };
      return b;
    },
    update: (patch: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      const apply = () => {
        const statusGuard = filters.find(([c]) => c === "fulfillment_status");
        if (statusGuard && statusGuard[1] !== db.order.fulfillment_status) return [];
        const restockGuard = filters.find(([c]) => c === "is:inventory_restocked_at");
        if (restockGuard && db.order.inventory_restocked_at !== null) return [];
        Object.assign(db.order, patch);
        return [{ id: db.order.id }];
      };
      const b: Record<string, unknown> = {
        eq(c: string, v: unknown) { filters.push([c, v]); return b; },
        is(c: string, v: unknown) { filters.push([`is:${c}`, v]); return b; },
        async select() { return { data: apply(), error: null }; },
        then(resolve: (v: unknown) => unknown) { apply(); return Promise.resolve({ error: null }).then(resolve); },
      };
      return b;
    },
    insert: async () => ({ error: null }),
  });
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "orders") return ordersTable();
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
          }),
          insert: async () => ({ error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      },
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  db.order = freshOrder();
  db.restocked = [];
  db.released = [];
  db.alerts = [];
});

async function cancelVia(to: string) {
  const { setOrderFulfillmentStatus } = await import("@/lib/shippo/service");
  return setOrderFulfillmentStatus({ orderId: db.order.order_id, to, source: "admin", actor: "owner" });
}

describe("every path that cancels an order returns its stock", () => {
  it("restocks at the chokepoint, so a caller cannot forget to", async () => {
    // setOrderFulfillmentStatus is the SOLE writer of fulfillment_status.
    // Putting the restock here is what makes "any future path that cancels must
    // return the stock" true by construction rather than by memory.
    const result = await cancelVia("cancelled");

    expect(result.ok).toBe(true);
    expect(db.order.fulfillment_status).toBe("cancelled");
    expect(db.restocked).toHaveLength(1);
    expect(db.restocked[0]).toEqual([{ product_id: "bpc-157::dose-5mg", quantity: 4 }]);
  });

  it("covers the BULK cancel, which never called the restock at all", async () => {
    // lib/admin-orders.ts does not import order-cancellation-inventory. It
    // reaches cancelled through this same writer, so it now inherits the fix.
    const { bulkUpdateAdminOrders } = await import("@/lib/admin-orders");
    await bulkUpdateAdminOrders({ orderIds: [db.order.order_id], action: "cancel" } as never);

    expect(db.order.fulfillment_status).toBe("cancelled");
    expect(db.restocked).toHaveLength(1);
  });

  it("does not restock twice when a caller also asks explicitly", async () => {
    // The single-order route called returnInventoryForCancelledOrder itself. The
    // exactly-once claim is what makes the chokepoint and any leftover caller
    // safe together.
    await cancelVia("cancelled");
    const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");
    const second = await returnInventoryForCancelledOrder(db.order.order_id);

    expect(second.action).toBe("already_returned");
    expect(db.restocked).toHaveLength(1);
  });

  it("leaves a non-cancel transition alone", async () => {
    // Only cancellation returns stock. Advancing an order must never touch it.
    const result = await cancelVia("ready_to_fulfill");

    expect(result.ok).toBe(true);
    expect(db.restocked).toHaveLength(0);
    expect(db.released).toHaveLength(0);
  });
});

describe("cancelling an order whose label is already bought", () => {
  it("does NOT restock — the parcel may already be with the carrier", async () => {
    // FULFILLMENT_TRANSITIONS really does allow label_purchased -> cancelled
    // (order-pipeline.ts:271-280), and fulfillment-workstation renders a queue
    // for exactly these orders. So "cancel is pre-carrier by construction" is
    // false, and restocking here would INVENT units — the failure the K-17
    // docblock claims to prevent, arrived at through its own wrong premise.
    db.order = freshOrder({ fulfillment_status: "label_purchased" });

    const result = await cancelVia("cancelled");

    expect(result.ok).toBe(true);
    expect(db.restocked).toHaveLength(0);
  });

  it("says so, rather than silently doing nothing", async () => {
    db.order = freshOrder({ fulfillment_status: "label_purchased" });

    await cancelVia("cancelled");

    // Somebody has to decide whether those units came back. Silence here is the
    // same defect as the "released" string this whole area started with.
    expect(db.alerts.map((a) => a.type)).toContain("cancellation_after_label_purchase");
  });
});
