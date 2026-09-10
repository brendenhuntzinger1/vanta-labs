import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PAID, BUT THE STOCK NEVER MOVED — AND NOTHING EVER LOOKED AGAIN.
//
// The paid side-effects claim is taken BEFORE any effect runs:
//
//   update(paid_side_effects_at = now).is(paid_side_effects_at, null)
//
// That is deliberate and must stay — it is what stops a redelivered webhook
// from emailing a second receipt and paying an ambassador twice. But the claim
// is single-use and nothing marks it COMPLETE, so an invocation killed after
// taking it leaves the order paid with its work permanently undone. The
// processor's retry finds the claim spent and does nothing at all.
//
// Three of the four effects behind that claim already had a repair job in the
// sweep (commission accrual, the email reaper, the customer-offer redeem).
// Inventory had none, and it is the one that loses money in BOTH directions:
//
//   * stock sold but never decremented is oversold to the next shopper;
//   * inventory_committed_at left NULL is also what the cancel path reads, so
//     a later cancel RESTOCKS units that never left — inventing stock.
//
// These tests pin the absence-keyed repair, and in particular the two cases
// where it must NOT write the receipt.
// ---------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  payment_status: string;
  order_type: string | null;
  paid_at: string;
  inventory_committed_at: string | null;
  inventory_restocked_at: string | null;
}

const db: {
  orders: OrderRow[];
  items: Record<string, Array<{ product_id: string; quantity: number }>>;
  finalize: { finalized: number; degraded: boolean; finalizedLines: Array<{ slug: string; variantId: string | null; quantity: number }> | null };
  decrement: { attempted: number; failed: number; errors: string[] };
  receiptWrites: string[];
  released: string[];
} = {
  orders: [],
  items: {},
  finalize: { finalized: 0, degraded: false, finalizedLines: null },
  decrement: { attempted: 0, failed: 0, errors: [] },
  receiptWrites: [],
  released: [],
};

const alerts: Array<{ type: string; severity: string }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string }) => { alerts.push(alert); },
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: async () => db.finalize,
  releaseInventoryForOrder: async (orderId: string) => { db.released.push(orderId); },
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: async () => db.decrement,
  // The REAL matcher, not a stub. The lines are keyed by slug/variant, so a
  // stub that matched on product_id string equality would let a dose-stocked
  // line be decremented twice and the test would never notice.
  itemsNotFinalized: (
    items: Array<{ product_id?: string | null }>,
    finalizedLines: Array<{ slug: string; variantId: string | null }>,
  ) => {
    const moved = new Set(finalizedLines.map((l) => `${l.slug}::${l.variantId ?? ""}`));
    return items.filter((item) => {
      const [slug, variant] = String(item.product_id ?? "").split("::");
      return !moved.has(`${slug}::${variant ?? ""}`);
    });
  },
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            in() { return b; }, is() { return b; }, gte() { return b; }, lte() { return b; },
            order() { return b; },
            limit: async () => ({ data: db.orders, error: null }),
          };
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          let id = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            is() { return b; },
            then(resolve: (v: unknown) => unknown) {
              if (payload.inventory_committed_at) db.receiptWrites.push(id);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }
    if (table === "order_items") {
      return {
        select: () => {
          let id = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            then(resolve: (v: unknown) => unknown) {
              return Promise.resolve({ data: db.items[id] ?? [], error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }
    return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
  };
  return { supabaseAdmin: { from } };
});

const strandedOrder = (overrides: Partial<OrderRow> = {}): OrderRow => ({
  order_id: "order-stranded-1",
  payment_status: "paid",
  order_type: "product",
  paid_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  inventory_committed_at: null,
  inventory_restocked_at: null,
  ...overrides,
});

async function runRepair() {
  const { repairMissingInventoryCommits } = await import("@/lib/inventory-commit-repair");
  return repairMissingInventoryCommits();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  db.orders = [];
  db.items = {};
  db.finalize = { finalized: 0, degraded: false, finalizedLines: null };
  db.decrement = { attempted: 0, failed: 0, errors: [] };
  db.receiptWrites = [];
  db.released = [];
  alerts.length = 0;
});

describe("the inventory commit repair", () => {
  it("finalizes a stranded paid order's hold and writes the receipt", async () => {
    db.orders = [strandedOrder()];
    db.items = { "order-stranded-1": [{ product_id: "cjc-1295-2mg", quantity: 2 }] };
    // A healthy finalize that moved the whole order: nothing left to decrement.
    db.finalize = { finalized: 1, degraded: false, finalizedLines: null };

    const result = await runRepair();

    expect(result.repaired).toBe(1);
    expect(result.failed).toBe(0);
    expect(db.receiptWrites).toEqual(["order-stranded-1"]);
  });

  it("decrements only the lines the finalize did not move", async () => {
    db.orders = [strandedOrder()];
    db.items = {
      "order-stranded-1": [
        { product_id: "bpc-157-10mg::dose-a", quantity: 1 },
        { product_id: "cjc-1295-2mg", quantity: 1 },
      ],
    };
    // The RPC moved the dosed line only — so exactly one line remains.
    db.finalize = { finalized: 1, degraded: false, finalizedLines: [{ slug: "bpc-157-10mg", variantId: "dose-a", quantity: 1 }] };
    db.decrement = { attempted: 1, failed: 0, errors: [] };

    const result = await runRepair();

    expect(result.repaired).toBe(1);
    expect(db.receiptWrites).toEqual(["order-stranded-1"]);
  });

  it("withholds the receipt when only SOME lines moved, because a later cancel would invent units", async () => {
    db.orders = [strandedOrder()];
    db.items = {
      "order-stranded-1": [
        { product_id: "a", quantity: 1 },
        { product_id: "b", quantity: 1 },
      ],
    };
    db.finalize = { finalized: 0, degraded: false, finalizedLines: [] };
    db.decrement = { attempted: 2, failed: 1, errors: ["b failed"] };

    const result = await runRepair();

    expect(result.partial).toBe(1);
    expect(result.repaired).toBe(0);
    // THE POINT: no receipt. Under-restock is recoverable; over-restock oversells.
    expect(db.receiptWrites).toEqual([]);
    expect(alerts.map((a) => a.type)).toContain("inventory_commit_repair_partial");
  });

  it("alerts critically when nothing moved at all — the units are sold and still on the shelf", async () => {
    db.orders = [strandedOrder()];
    db.items = { "order-stranded-1": [{ product_id: "a", quantity: 1 }] };
    db.finalize = { finalized: 0, degraded: false, finalizedLines: [] };
    db.decrement = { attempted: 1, failed: 1, errors: ["rpc down"] };

    const result = await runRepair();

    expect(result.failed).toBe(1);
    expect(db.receiptWrites).toEqual([]);
    const critical = alerts.find((a) => a.type === "inventory_commit_repair_failed");
    expect(critical?.severity).toBe("critical");
  });

  it("releases the holds a DEGRADED finalize left active, so stock is not both sold and reserved", async () => {
    db.orders = [strandedOrder()];
    db.items = { "order-stranded-1": [{ product_id: "a", quantity: 1 }] };
    // A degraded RPC moved nothing reliable; the fallback moves the units
    // directly and does not touch reserved_quantity, and the expiry sweep skips
    // paid orders — so without this the units are decremented AND reserved for
    // ever, and the storefront reports availability net of a hold nobody holds.
    db.finalize = { finalized: 0, degraded: true, finalizedLines: null };
    db.decrement = { attempted: 1, failed: 0, errors: [] };

    await runRepair();

    expect(db.released).toEqual(["order-stranded-1"]);
  });

  it("ignores an order whose line items cannot be read rather than reporting success", async () => {
    // An unreadable list is not an order with no lines. Treating it as empty
    // would decrement nothing, write the receipt, and leave sold stock on the
    // shelf with the claim already spent.
    db.orders = [strandedOrder()];
    db.items = {};
    db.finalize = { finalized: 0, degraded: false, finalizedLines: [] };

    const result = await runRepair();

    expect(db.receiptWrites).toEqual([]);
    expect(result.repaired).toBe(0);
  });

  it("leaves membership orders alone — they hold no stock", async () => {
    db.orders = [strandedOrder({ order_type: "membership" })];

    const result = await runRepair();

    expect(result.scanned).toBe(0);
    expect(db.receiptWrites).toEqual([]);
  });
});
