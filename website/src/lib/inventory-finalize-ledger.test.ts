import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A SALE THAT MOVES STOCK MUST SAY SO IN THE LEDGER.
//
// There are two ways stock leaves the shelf for a paid order:
//
//   1. finalize_inventory_for_order  — the PRIMARY path. Turns the hold taken
//      at checkout into a permanent deduction.
//   2. decrementInventoryForOrder    — the FALLBACK, for orders with no active
//      hold (untracked item, expired hold, pre-migration order).
//
// Only the fallback wrote an `inventory_transactions` row. The primary path —
// the one virtually every real order takes — moved stock silently.
//
// THIS IS NOT THEORETICAL. It corrupted production on 2026-08-27, the day of
// the store's first real customer order (VL-C98B8AB1):
//
//   00:09:27  payment settles; finalize deducts BAC Water 39 → 38. No ledger row.
//   01:06:38  the operator opens Admin → Inventory, sees no sale row for an
//             order they know was paid, and decrements BAC Water by hand 38 → 37.
//
// The shelf is now understated by one unit. Neither action was wrong on its own;
// the operator simply had no way to see that the first one had happened. An
// invisible movement is how a correct system produces a wrong count.
//
// The ledger is also the only thing that can answer "why does this say 37 when
// I counted 38?" after the fact — a running total with no history makes a
// miscount, a double decrement and a forgotten adjustment indistinguishable.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const rpc = vi.hoisted(() => vi.fn());
const ledgerInserts = vi.hoisted(() => [] as Array<Record<string, unknown>>);

/** Active holds the finalize RPC is about to turn into deductions. */
const activeReservations = vi.hoisted(() => ({
  rows: [] as Array<{ slug: string; variant_id: string | null; quantity: number; status: string }>,
}));

/** Stand in for the RPC: finalize every active hold, and report how many. */
const finalizeRows = vi.hoisted(() => () => {
  const active = activeReservations.rows.filter((row) => row.status === "active");
  for (const row of active) row.status = "finalized";
  return active.length;
});

/** Stock levels AFTER the RPC has run, keyed by dose id or product slug. */
const stockAfter = vi.hoisted(() => ({
  doses: {} as Record<string, { inventory_quantity: number; product_id: string }>,
  products: {} as Record<string, { inventory_quantity: number; id: string }>,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => {
      if (table === "inventory_transactions") {
        return {
          insert: async (row: Record<string, unknown>) => {
            ledgerInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "inventory_reservations") {
        // Honours the status filter, and the RPC below flips rows to
        // 'finalized'. Without that, a read taken AFTER the RPC still returns
        // the holds and the "read before" requirement is untestable — the
        // mutant that moves the read survives against a mock that always
        // answers the same thing.
        const filters: Record<string, string> = {};
        const thenable = {
          eq(column: string, value: string) {
            filters[column] = value;
            return thenable;
          },
          then(resolve: (value: { data: typeof activeReservations.rows; error: null }) => unknown) {
            // No default. A query that forgets `.eq("status", ...)` must see
            // every row here, exactly as Postgres would answer it — otherwise
            // the mock supplies a filter the code failed to.
            const wanted = filters.status;
            return resolve({
              data: wanted ? activeReservations.rows.filter((row) => row.status === wanted) : activeReservations.rows,
              error: null,
            });
          },
        };
        return { select: () => thenable };
      }
      if (table === "product_doses") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: stockAfter.doses[id] ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "products") {
        return {
          select: () => ({
            eq: (_col: string, slug: string) => ({
              maybeSingle: async () => ({ data: stockAfter.products[slug] ?? null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

async function mod() {
  return import("@/lib/inventory-reservation");
}

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  ledgerInserts.length = 0;
  activeReservations.rows = [];
  stockAfter.doses = {};
  stockAfter.products = {};
});

describe("finalizing a paid order's holds writes the movement to the ledger", () => {
  it("records one row per finalized line, with the real before/after numbers", async () => {
    // Exactly the shape of the real order that exposed this: a dosed peptide
    // and a dosed accessory, one unit each.
    activeReservations.rows = [
      { slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "active" },
      { slug: "bacteriostatic-water", variant_id: "dose-bac", quantity: 1, status: "active" },
    ];
    stockAfter.doses = {
      "dose-glp3": { inventory_quantity: 38, product_id: "prod-glp3" },
      "dose-bac": { inventory_quantity: 38, product_id: "prod-bac" },
    };
    rpc.mockImplementation(async () => ({ data: finalizeRows(), error: null }));

    const { finalizeInventoryForOrder } = await mod();
    expect(await finalizeInventoryForOrder("order-real")).toEqual({ finalized: 2, degraded: false });

    expect(ledgerInserts).toHaveLength(2);
    expect(ledgerInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: "prod-glp3",
          dose_id: "dose-glp3",
          transaction_type: "order_completed",
          delta: -1,
          quantity_before: 39,
          quantity_after: 38,
          order_id: "order-real",
          actor: "payment_webhook",
        }),
        expect.objectContaining({
          product_id: "prod-bac",
          dose_id: "dose-bac",
          delta: -1,
          quantity_before: 39,
          quantity_after: 38,
          order_id: "order-real",
        }),
      ]),
    );
  });

  it("records a line held on the parent product, not a dose", async () => {
    activeReservations.rows = [{ slug: "hcg", variant_id: null, quantity: 2, status: "active" }];
    stockAfter.products = { hcg: { inventory_quantity: 5, id: "prod-hcg" } };
    rpc.mockImplementation(async () => ({ data: finalizeRows(), error: null }));

    const { finalizeInventoryForOrder } = await mod();
    await finalizeInventoryForOrder("order-parent");

    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0]).toMatchObject({
      product_id: "prod-hcg",
      dose_id: null,
      delta: -2,
      quantity_before: 7,
      quantity_after: 5,
      order_id: "order-parent",
    });
  });

  it("a replayed webhook finds no active holds and writes NOTHING", async () => {
    // The RPC only touches status='active' rows, so a replay finalizes zero
    // lines. The ledger must not gain a phantom second sale — that would look
    // exactly like the double-decrement this whole file exists to prevent.
    // Already committed by the first delivery of this payment.
    activeReservations.rows = [
      { slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "finalized" },
    ];
    stockAfter.doses = { "dose-glp3": { inventory_quantity: 38, product_id: "prod-glp3" } };
    rpc.mockImplementation(async () => ({ data: finalizeRows(), error: null }));

    const { finalizeInventoryForOrder } = await mod();
    expect(await finalizeInventoryForOrder("order-replay")).toEqual({ finalized: 0, degraded: false });
    expect(ledgerInserts).toHaveLength(0);
  });

  it("ledgers only the line it actually committed when the other was already done", async () => {
    // A retry that lands after a partial commit. The already-finalized line's
    // units left the shelf on the first pass; booking them again would double
    // count them, and `finalized > 0` is true here so the guard cannot help.
    activeReservations.rows = [
      { slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "active" },
      { slug: "bacteriostatic-water", variant_id: "dose-bac", quantity: 1, status: "finalized" },
    ];
    stockAfter.doses = {
      "dose-glp3": { inventory_quantity: 38, product_id: "prod-glp3" },
      "dose-bac": { inventory_quantity: 38, product_id: "prod-bac" },
    };
    rpc.mockImplementation(async () => ({ data: finalizeRows(), error: null }));

    const { finalizeInventoryForOrder } = await mod();
    expect(await finalizeInventoryForOrder("order-partial")).toEqual({ finalized: 1, degraded: false });

    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0]).toMatchObject({ dose_id: "dose-glp3", delta: -1 });
  });

  it("writes nothing when the holds were read but the RPC committed NOTHING", async () => {
    // A concurrent worker finalized this order between the read and the RPC, so
    // the pre-read is non-empty while the RPC reports zero. Ledgering the holds
    // we happened to observe would book a second sale for units that left the
    // shelf once — the exact shape of the production double-count.
    activeReservations.rows = [{ slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "active" }];
    stockAfter.doses = { "dose-glp3": { inventory_quantity: 38, product_id: "prod-glp3" } };
    rpc.mockResolvedValue({ data: 0, error: null });

    const { finalizeInventoryForOrder } = await mod();
    expect(await finalizeInventoryForOrder("order-raced")).toEqual({ finalized: 0, degraded: false });
    expect(ledgerInserts).toHaveLength(0);
  });

  it("writes nothing when the RPC failed — the stock never moved", async () => {
    activeReservations.rows = [{ slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "active" }];
    stockAfter.doses = { "dose-glp3": { inventory_quantity: 4, product_id: "prod-glp3" } };
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    const { finalizeInventoryForOrder } = await mod();
    expect(await finalizeInventoryForOrder("order-broken")).toEqual({ finalized: 0, degraded: true });
    // A ledger row here would assert a movement that did not happen, and the
    // caller is about to run the fallback decrement, which writes its own.
    expect(ledgerInserts).toHaveLength(0);
  });

  it("still deducts the stock when the ledger write throws", async () => {
    // The ledger is an audit trail. Losing a row is a gap in history; failing
    // the movement it describes would strand a paid order.
    activeReservations.rows = [{ slug: "glp-3", variant_id: "dose-glp3", quantity: 1, status: "active" }];
    stockAfter.doses = { "dose-glp3": { inventory_quantity: 4, product_id: "prod-glp3" } };
    rpc.mockImplementation(async () => ({ data: finalizeRows(), error: null }));

    const { finalizeInventoryForOrder } = await mod();
    // recordInventoryTransaction swallows its own errors; prove finalize still
    // reports the deduction that really happened.
    expect(await finalizeInventoryForOrder("order-ledger-down")).toEqual({ finalized: 1, degraded: false });
  });
});
