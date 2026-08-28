import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// VL-12 / CRON-01: THE CLAIM WAS A TOMBSTONE, NOT A LEASE.
//
// `shippo_sync_claimed_at` is taken before an order is pushed to Shippo and was
// cleared on exactly ONE path — a Shippo failure that is demonstrably safe to
// retry. Nothing cleared it when a run simply STOPPED: the 60-second function
// limit, a redeploy mid-request, a reaped container. The column stayed set with
// no writer anywhere that would ever unset it.
//
// The consequence is not one lost order. sweepUnsyncedOrders selects on
// `shippo_order_id is null` ordered by paid_at, twenty at a time — so a
// permanently-claimed order matches that window for ever, is picked up every
// thirty minutes, loses the claim every time, and holds one of the twenty slots
// while newer paid orders queue behind it. Twenty stranded orders is a sweep
// that does nothing at all.
//
// The lease expires. What it must NOT do is expire the one hold that is
// deliberate: when Shippo answers in a way that means "the order may exist but
// I cannot tell you", the claim is kept ON PURPOSE and a human clears it.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-lease-0001";
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

const mocks = vi.hoisted(() => ({
  createShippoOrder: vi.fn(async () => ({ ok: true as const, data: { object_id: "shippo_order_new" } })),
  createShipmentWithRates: vi.fn(async () => ({ ok: true as const, data: { shipmentId: "shp_1", rates: [] } })),
  recordSystemAlert: vi.fn(async () => {}),
}));

const state: { order: Record<string, unknown> } = { order: {} };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: mocks.recordSystemAlert }));
vi.mock("@/lib/shippo/config", () => ({ isShippoConfigured: () => true }));
vi.mock("@/lib/shippo/client", () => ({
  createShippoOrder: mocks.createShippoOrder,
  createShipmentWithRates: mocks.createShipmentWithRates,
  getTransaction: vi.fn(),
}));
vi.mock("@/lib/shippo/service", () => ({
  buildOrderParcel: async () => ({
    ok: true as const,
    data: {
      weightOz: 8,
      parcel: { length: "6", width: "4", height: "2", distance_unit: "in", weight: "8", mass_unit: "oz" },
      lines: [{ name: "Item", productId: "prod-1", quantity: 1, unitWeightOz: 8 }],
    },
  }),
  toCountryCode: (v: string) => v || "US",
}));
vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost: vi.fn(async () => {}) }));
vi.mock("@/lib/order-pipeline", () => ({ canTransition: () => true }));
const address = {
  name: "Origin", company: "", street1: "1 Origin Way", street2: "", city: "Testville",
  state: "FL", zip: "33333", country: "US", phone: "", email: "",
};
vi.mock("@/lib/shipping-origin", () => ({
  getShippingAddresses: async () => ({
    canRequestRates: true, blockedReason: null, origin: address, returnAddress: address,
  }),
}));

// A double over ONE orders row that honours the filters, because every question
// here is about whether a conditional update matched.
//
// IT ALSO ROUNDS TIMESTAMPS ON THE WAY OUT, and that is the point. Postgres
// stores `shippo_sync_claimed_at` to the microsecond; what comes back through
// the JSON layer is rounded to the millisecond. An earlier version of the
// reclaim compare-and-swapped on `eq(<the value it had just read>)` and
// therefore matched NOTHING, silently — every test passed, because a double
// that echoes back the string it was handed cannot show it. Caught against a
// real Postgres. Modelled here so it cannot come back.
const WIRE_PRECISION_MS = 1;
const toWire = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Math.floor(Date.parse(value) / WIRE_PRECISION_MS) * WIRE_PRECISION_MS).toISOString()
    : value;

vi.mock("@/lib/supabase-server", () => {
  const compare = (cell: unknown, val: unknown) => {
    const a = Date.parse(String(cell));
    const b = Date.parse(String(val));
    return Number.isFinite(a) && Number.isFinite(b)
      ? a - b
      : String(cell ?? "").localeCompare(String(val ?? ""));
  };

  const matches = (filters: Array<[string, string, unknown]>) =>
    filters.every(([op, col, val]) => {
      // Filters run against what the DATABASE holds, at full precision — a
      // client that echoes a rounded value back gets no match, exactly as
      // Postgres would answer.
      const cell = state.order[col] ?? null;
      if (op === "is") return cell === val;
      if (op === "lt") return cell !== null && compare(cell, val) < 0;
      return cell === val;
    });

  const from = (table: string) => {
    if (table !== "orders") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    return {
      select: () => {
        const filters: Array<[string, string, unknown]> = [];
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
          is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
          lt(c: string, v: unknown) { filters.push(["lt", c, v]); return b; },
          async maybeSingle() {
            if (!matches(filters)) return { data: null, error: null };
            // Rounded on the way out, like the wire.
            const row = { ...state.order, shippo_sync_claimed_at: toWire(state.order.shippo_sync_claimed_at) };
            return { data: row, error: null };
          },
        };
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, string, unknown]> = [];
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
          is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
          lt(c: string, v: unknown) { filters.push(["lt", c, v]); return b; },
          async select() {
            if (!matches(filters)) return { data: [], error: null };
            Object.assign(state.order, payload);
            return { data: [{ id: "row-1" }], error: null };
          },
          then(resolve: (v: { data: unknown; error: null }) => unknown) {
            if (matches(filters)) Object.assign(state.order, payload);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return b;
      },
    };
  };
  return { supabaseAdmin: { from } };
});

function order(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    order_number: "VL-LEASE001",
    payment_status: "paid",
    order_type: "product",
    shippo_order_id: null,
    shippo_shipment_id: null,
    shippo_sync_claimed_at: null,
    shippo_sync_status: null,
    shippo_sync_error: null,
    currency: "USD",
    paid_at: "2026-08-20T00:00:00.000Z",
    subtotal: 100, amount_paid: 110, shipping_amount: 10, tax_amount: 0,
    customer_name: "A Buyer", customer_email: "buyer@example.test",
    shipping_address: "1 Test Street", shipping_address_2: "",
    city: "Testville", state: "FL", postal_code: "33333", country: "US",
    ...overrides,
  };
}

// Microsecond precision, as Postgres stores it — the digits the wire drops.
const agoIso = (ms: number) =>
  new Date(Date.now() - ms).toISOString().replace(/\.(\d{3})Z$/, ".$1961+00:00");

async function sync() {
  const { syncOrderToShippo } = await import("@/lib/shippo/order-sync");
  return syncOrderToShippo(ORDER_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state.order = order();
});

describe("the sync claim as a lease", () => {
  it("is taken, and the push happens, when nothing holds it", async () => {
    const result = await sync();

    expect(result.ok).toBe(true);
    expect(mocks.createShippoOrder).toHaveBeenCalledTimes(1);
  });

  it("is respected while a run could still be using it", async () => {
    // A minute old. A live run holds this — pushing now is the duplicate the
    // claim exists to prevent.
    state.order = order({ shippo_sync_claimed_at: agoIso(60_000) });

    const result = await sync();

    expect(result).toMatchObject({ ok: false, reason: "A sync is already in progress.", retryable: true });
    expect(mocks.createShippoOrder).not.toHaveBeenCalled();
  });

  it("EXPIRES once no run could possibly still hold it", async () => {
    // Older than the lease. maxDuration is 60s and a Shippo call gives up at
    // 15s, so nothing alive has held this for half an hour: the run that took
    // it died. Before the TTL this order was stranded for ever.
    state.order = order({ shippo_sync_claimed_at: agoIso(THIRTY_MINUTES_MS + 60_000) });

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(mocks.createShippoOrder).toHaveBeenCalledTimes(1);
  });

  it("says so when it reclaims one, instead of repairing it silently", async () => {
    state.order = order({ shippo_sync_claimed_at: agoIso(THIRTY_MINUTES_MS + 60_000) });

    await sync();

    expect(mocks.recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shippo_sync_claim_reclaimed",
        severity: "warning",
        context: expect.objectContaining({ orderId: ORDER_ID }),
      }),
    );
  });

  it("bounds that notice, so a persistently crashing sync reports a condition and not a stream", async () => {
    state.order = order({ shippo_sync_claimed_at: agoIso(THIRTY_MINUTES_MS + 60_000) });

    await sync();

    const [alert] = mocks.recordSystemAlert.mock.calls[0] as unknown as [{ dedupeWindowMs?: number }];
    expect(alert.dedupeWindowMs).toBeGreaterThan(0);
  });

  it("NEVER expires the deliberate hold, however old it gets", async () => {
    // Shippo answered in a way that means the order may exist but cannot be
    // named (a 5xx, a timeout). syncOrderToShippo keeps the claim on purpose
    // and stamps 'error'. Re-pushing would put a second copy in the Orders tab
    // for one parcel. Only the admin retry button — a human who has looked in
    // Shippo — clears this.
    state.order = order({
      shippo_sync_claimed_at: agoIso(30 * 24 * 60 * 60 * 1000),
      shippo_sync_status: "error",
      shippo_sync_error: "Shippo is unavailable right now.",
    });

    const result = await sync();

    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(mocks.createShippoOrder).not.toHaveBeenCalled();
    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });

  it("never reclaims an order that did reach Shippo", async () => {
    state.order = order({
      shippo_sync_claimed_at: agoIso(THIRTY_MINUTES_MS + 60_000),
      shippo_order_id: "shippo_order_existing",
    });

    const result = await sync();

    expect(result).toMatchObject({ ok: true, shippoOrderId: "shippo_order_existing", created: false });
    expect(mocks.createShippoOrder).not.toHaveBeenCalled();
  });

  it("lets exactly one of two racing sweeps take over a dead lease", async () => {
    // The retake is a compare-and-swap on the timestamp that was read. Without
    // it, every sweep that sees the same dead lease pushes, and the TTL fix
    // would have replaced one stranded order with N duplicates.
    state.order = order({ shippo_sync_claimed_at: agoIso(THIRTY_MINUTES_MS + 60_000) });

    await Promise.all([sync(), sync()]);

    expect(mocks.createShippoOrder).toHaveBeenCalledTimes(1);
  });
});
