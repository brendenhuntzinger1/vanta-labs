import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT REACHES SHIPPO'S ORDERS TAB, AND WHAT MUST NOT.
//
// This push is what makes the owner's workflow one click: the order is already
// in Shippo with the customer, the address, the line items and the parcel, so
// nothing is retyped at the packing bench. Everything about that convenience
// depends on pushing the RIGHT things and only the right things.
//
// WHY THIS FILE EXISTS
//
// Six separate guards could each be deleted with all 2,738 existing tests
// green:
//   - only PAID orders are pushed          (an unpaid order becomes shippable)
//   - MEMBERSHIPS are never pushed         (a parcel for something digital)
//   - a blocked ship-from address STOPS it (a shipment with no valid origin)
//   - the reference is the ORDER NUMBER    (the owner reads VL-XXXXXXXX, and
//                                           the transaction matcher reads it
//                                           back -- this is the exact writer/
//                                           reader pairing that has bitten
//                                           this codebase before)
//   - an already-synced order short-circuits (duplicate Shippo orders)
//   - the sync is CLAIMED before pushing     (two callers, two orders)
// ---------------------------------------------------------------------------

const ORDER_ID = "order-push-0001";
const ORDER_NUMBER = "VL-PUSH0001";

const state: {
  order: Record<string, unknown>;
  claimAvailable: boolean;
  canRequestRates: boolean;
  blockedReason: string | null;
  updates: Record<string, unknown>[];
} = {
  order: {},
  claimAvailable: true,
  canRequestRates: true,
  blockedReason: null,
  updates: [],
};

const { createShippoOrder, createShipmentWithRates, buildOrderParcel } = vi.hoisted(() => ({
  createShippoOrder: vi.fn(async (_payload: Record<string, unknown>) => ({
    ok: true as const,
    data: { object_id: "shippo_order_new" },
  })),
  createShipmentWithRates: vi.fn(async () => ({ ok: true as const, data: { rates: [] } })),
  buildOrderParcel: vi.fn(async () => ({
    ok: true as const,
    data: {
      weightOz: 8,
      parcel: { length: "6", width: "4", height: "2", distance_unit: "in", weight: "8", mass_unit: "oz" },
      lines: [{ name: "BPC-157 10mg", productId: "prod-1", quantity: 2, unitWeightOz: 3 }],
    },
  })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/shippo/config", () => ({ isShippoConfigured: () => true }));
vi.mock("@/lib/shippo/client", () => ({ createShippoOrder, createShipmentWithRates }));
vi.mock("@/lib/shippo/service", () => ({ buildOrderParcel, toCountryCode: (v: string) => v || "US" }));
vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost: vi.fn(async () => {}) }));
vi.mock("@/lib/shipping-origin", () => ({
  getShippingAddresses: async () => ({
    canRequestRates: state.canRequestRates,
    blockedReason: state.blockedReason,
    origin: {
      name: "ZZORIGINNAMEZZ",
      company: "",
      street1: "ZZPRIVATESTREETZZ",
      street2: "",
      city: "ZZPRIVATECITYZZ",
      state: "FL",
      zip: "00000",
      country: "US",
      phone: "",
      email: "",
    },
    returnAddress: {
      name: "ZZRETURNNAMEZZ",
      company: "",
      street1: "ZZRETURNSTREETZZ",
      street2: "",
      city: "ZZRETURNCITYZZ",
      state: "FL",
      zip: "11111",
      country: "US",
      phone: "",
      email: "",
    },
  }),
}));

vi.mock("@/lib/supabase-server", () => {
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
        const b: Record<string, unknown> = {
          eq() { return b; },
          async maybeSingle() { return { data: { ...state.order }, error: null }; },
        };
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        let requiresNullClaim = false;
        const b: Record<string, unknown> = {
          eq() { return b; },
          is(column: string, value: unknown) {
            if (column === "shippo_sync_claimed_at" && value === null) requiresNullClaim = true;
            return b;
          },
          async select() {
            state.updates.push(payload);
            if (requiresNullClaim) {
              // Models the atomic claim: it matches only while unclaimed.
              if (!state.claimAvailable) return { data: [], error: null };
              state.claimAvailable = false;
              return { data: [{ id: "row-1" }], error: null };
            }
            return { data: [{ id: "row-1" }], error: null };
          },
          then(resolve: (v: { data: unknown; error: null }) => unknown) {
            state.updates.push(payload);
            Object.assign(state.order, payload);
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
    order_number: ORDER_NUMBER,
    payment_status: "paid",
    order_type: "product",
    shippo_order_id: null,
    currency: "USD",
    paid_at: "2026-08-20T00:00:00.000Z",
    subtotal: 200,
    amount_paid: 215,
    shipping_amount: 15,
    tax_amount: 0,
    customer_name: "A Buyer",
    customer_email: "buyer@example.test",
    shipping_address: "1 Test Street",
    shipping_address_2: "Apt 4B",
    city: "Testville",
    state: "FL",
    postal_code: "33333",
    country: "US",
    ...overrides,
  };
}

async function sync() {
  const { syncOrderToShippo } = await import("@/lib/shippo/order-sync");
  return syncOrderToShippo(ORDER_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.order = order();
  state.claimAvailable = true;
  state.canRequestRates = true;
  state.blockedReason = null;
  state.updates = [];
});

describe("a paid physical order is pushed", () => {
  it("creates the Shippo order", async () => {
    const result = await sync();
    expect(result.ok).toBe(true);
    expect(createShippoOrder).toHaveBeenCalledTimes(1);
  });

  it("carries the ORDER NUMBER as the reference, which is what the matcher reads back", async () => {
    await sync();
    const payload = createShippoOrder.mock.calls[0][0] as unknown as { order_number: string };
    // The writer/reader pairing: applyTransactionCreated looks this value up in
    // the order_number column. Sending the internal id here would silently
    // resolve nothing for every label bought in Shippo's dashboard.
    expect(payload.order_number).toBe(ORDER_NUMBER);
  });

  it("sends the customer's full address, including the apartment line", async () => {
    await sync();
    const payload = createShippoOrder.mock.calls[0][0] as unknown as { to_address: Record<string, string> };
    const flattened = JSON.stringify(payload.to_address);
    // A missing street2 ships to the building and not the unit.
    expect(flattened).toContain("Apt 4B");
    expect(flattened).toContain("1 Test Street");
    expect(flattened).toContain("Testville");
    expect(flattened).toContain("33333");
  });

  it("sends the parcel weight, so the owner does not retype the box", async () => {
    await sync();
    const payload = createShippoOrder.mock.calls[0][0] as unknown as { weight: string; line_items: unknown[] };
    expect(Number(payload.weight)).toBeGreaterThan(0);
    expect(payload.line_items).toHaveLength(1);
  });
});

describe("what must never reach Shippo", () => {
  for (const payment_status of ["pending_payment", "awaiting_verification", "payment_rejected", "refunded"]) {
    it(`refuses a ${payment_status} order`, async () => {
      state.order = order({ payment_status });
      const result = await sync();
      expect(result.ok).toBe(false);
      expect(createShippoOrder).not.toHaveBeenCalled();
    });
  }

  it("refuses a membership order — nothing will ever be posted", async () => {
    state.order = order({ order_type: "membership" });
    const result = await sync();
    expect(result.ok).toBe(false);
    expect(createShippoOrder).not.toHaveBeenCalled();
  });

  it("refuses to push when the ship-from address is unusable", async () => {
    state.canRequestRates = false;
    state.blockedReason = "Ship-from address is incomplete";
    const result = await sync();
    expect(result.ok).toBe(false);
    expect(createShippoOrder).not.toHaveBeenCalled();
  });

  it("records WHY it was blocked, so the failure is not silent", async () => {
    state.canRequestRates = false;
    state.blockedReason = "Ship-from address is incomplete";
    await sync();
    // A push that fails every 30 minutes forever with a blank error is
    // indistinguishable from one nothing has tried yet.
    const blocked = state.updates.find((u) => u.shippo_sync_status === "blocked");
    expect(blocked).toBeDefined();
    expect(String(blocked?.shippo_sync_error ?? "")).toContain("incomplete");
  });

  it("refuses when the parcel cannot be built", async () => {
    buildOrderParcel.mockResolvedValueOnce({
      ok: false as never,
      message: "No weight for BPC-157 10mg",
    } as never);
    const result = await sync();
    expect(result.ok).toBe(false);
    expect(createShippoOrder).not.toHaveBeenCalled();
  });
});

describe("pushing the same order twice", () => {
  it("short-circuits an order that already has a Shippo id", async () => {
    state.order = order({ shippo_order_id: "shippo_order_existing" });
    const result = await sync();
    expect(result.ok).toBe(true);
    // A second Shippo order means two entries in the owner's Orders tab for
    // one parcel.
    expect(createShippoOrder).not.toHaveBeenCalled();
  });

  it("claims the sync before pushing, so a concurrent caller cannot push too", async () => {
    state.claimAvailable = false; // another caller already holds the claim
    const result = await sync();
    expect(result.ok).toBe(false);
    expect(createShippoOrder).not.toHaveBeenCalled();
  });

  it("creates exactly one Shippo order when two pushes race", async () => {
    await Promise.all([sync(), sync()]);
    expect(createShippoOrder).toHaveBeenCalledTimes(1);
  });
});
