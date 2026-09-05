import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The Shippo service, against a fake database and a fake Shippo.
//
// Everything expensive is mocked; everything decided is real. The point of this
// suite is the money: a label must be bought exactly once no matter how many
// times the button is pressed, its cost must be recorded exactly, voiding must
// take that cost back out, and a webhook feed that repeats and reorders itself
// must not be able to email a customer twice or un-deliver a delivered order.
//
// vitest.setup.ts installs a generic global mock for @/lib/supabase-server. The
// vi.mock below replaces it for this file with a real in-memory table store,
// because the claim under test is `update ... where claimed_at is null`, and a
// mock that ignores filters cannot express losing that race.
// ---------------------------------------------------------------------------

interface Row {
  [column: string]: unknown;
}

// vi.mock factories are hoisted above every declaration in this file, so
// everything a factory touches has to be built inside vi.hoisted().
const harness = vi.hoisted(() => {
  interface HoistedRow {
    [column: string]: unknown;
  }

  /** table -> rows, plus the primary key that enforces uniqueness on insert. */
  const tables = new Map<string, HoistedRow[]>();
  const PRIMARY_KEYS: Record<string, string> = {
    shippo_webhook_events: "event_key",
  };

  function table(name: string): HoistedRow[] {
    const existing = tables.get(name);
    if (existing) return existing;
    const created: HoistedRow[] = [];
    tables.set(name, created);
    return created;
  }

  type Filter = (row: HoistedRow) => boolean;

  /**
   * A miniature PostgREST builder: thenable, chainable, and — critically —
   * FILTER-AWARE, so `.is("label_purchase_claimed_at", null)` really does
   * exclude a row that has already been claimed. A mock that ignored filters
   * could not express losing the race this whole suite exists to prove.
   */
  function createBuilder(name: string, mode: "select" | "update" | "delete", payload?: HoistedRow) {
    const filters: Filter[] = [];
    const sorted: Array<{ column: string; ascending: boolean }> = [];

    const run = () => {
      const rows = table(name).filter((row) => filters.every((filter) => filter(row)));
      if (mode === "update" && payload) {
        for (const row of rows) Object.assign(row, payload);
      }
      if (mode === "delete") {
        tables.set(
          name,
          table(name).filter((row) => !rows.includes(row)),
        );
      }
      const result = [...rows];
      for (const order of [...sorted].reverse()) {
        result.sort((a, b) => {
          const left = a[order.column];
          const right = b[order.column];
          const cmp = left === right ? 0 : (left ?? "") > (right ?? "") ? 1 : -1;
          return order.ascending ? cmp : -cmp;
        });
      }
      return { data: result, error: null as unknown };
    };

    const builder = {
      eq(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? "") === String(value));
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? "") !== String(value));
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push((row) =>
          value === null ? row[column] === null || row[column] === undefined : row[column] === value,
        );
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.map(String).includes(String(row[column])));
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        sorted.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      limit() {
        return builder;
      },
      select() {
        return builder;
      },
      async maybeSingle() {
        return { data: run().data[0] ?? null, error: null };
      },
      async single() {
        const row = run().data[0];
        return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
      },
      then(resolve: (value: { data: HoistedRow[]; error: unknown }) => unknown) {
        return Promise.resolve(run()).then(resolve);
      },
    };

    return builder;
  }

  const supabaseMock = {
    from(name: string) {
      return {
        select: () => createBuilder(name, "select"),
        update: (payload: HoistedRow) => createBuilder(name, "update", payload),
        delete: () => createBuilder(name, "delete"),
        insert(payload: HoistedRow | HoistedRow[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          const key = PRIMARY_KEYS[name];
          if (key) {
            for (const row of rows) {
              if (table(name).some((existing) => existing[key] === row[key])) {
                // The real primary-key violation webhook idempotency relies on.
                const error = { code: "23505", message: "duplicate key value violates unique constraint" };
                return {
                  error,
                  data: null,
                  select: () => ({ single: async () => ({ data: null, error }) }),
                  then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error }),
                };
              }
            }
          }
          const inserted = rows.map((row) => ({ id: `row-${table(name).length + 1}`, ...row }));
          table(name).push(...inserted);
          return {
            error: null,
            data: inserted,
            select: () => ({ single: async () => ({ data: inserted[0], error: null }) }),
            then: (resolve: (value: unknown) => unknown) => resolve({ data: inserted, error: null }),
          };
        },
        async upsert(payload: HoistedRow | HoistedRow[], options?: { onConflict?: string }) {
          const rows = Array.isArray(payload) ? payload : [payload];
          const key = options?.onConflict ?? "id";
          for (const row of rows) {
            const existing = table(name).find((candidate) => candidate[key] === row[key]);
            if (existing) Object.assign(existing, row);
            else table(name).push({ ...row });
          }
          return { data: null, error: null };
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
  };

  const origin = {
    name: "Vanta Labs",
    company: "",
    street1: "1 Example St",
    street2: "",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    phone: "5125550123",
    email: "",
  };

  return {
    tables,
    table,
    supabaseMock,
    origin,
    /** Flipped per test to simulate an unconfigured ship-from address. */
    state: { originComplete: true },
    createShipmentWithRates: vi.fn(),
    purchaseLabel: vi.fn(),
    voidLabel: vi.fn(),
    sendEmail: vi.fn(),
    recordActualShippingCost: vi.fn(),
  };
});

const { createShipmentWithRates, purchaseLabel, voidLabel, sendEmail, recordActualShippingCost } = harness;

function table(name: string): Row[] {
  return harness.table(name) as Row[];
}

function resetTables(): void {
  harness.tables.clear();
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: harness.supabaseMock,
  createServerClient: () => harness.supabaseMock,
}));

vi.mock("@/lib/shippo/client", async () => {
  // parseAmountToCents is real money math — never stub it.
  const actual = await vi.importActual<typeof import("@/lib/shippo/client")>("@/lib/shippo/client");
  return {
    ...actual,
    createShipmentWithRates: harness.createShipmentWithRates,
    purchaseLabel: harness.purchaseLabel,
    voidLabel: harness.voidLabel,
  };
});

vi.mock("@/lib/email/send", () => ({ sendEmail: harness.sendEmail }));

vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost: harness.recordActualShippingCost }));

vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/shipping-origin", () => ({
  getShippingAddresses: async () => ({
    origin: harness.origin,
    returnAddress: harness.origin,
    usesSeparateReturn: false,
    originValidation: {
      isComplete: harness.state.originComplete,
      missing: harness.state.originComplete ? [] : ["phone"],
    },
    returnValidation: { isComplete: true, missing: [] },
    canRequestRates: harness.state.originComplete,
  }),
}));

import {
  applyTrackingUpdate,
  buildOrderParcel,
  buildTrackingEventKey,
  clearQuotedRateCache,
  getLabelUrlForOrder,
  getRatesForOrder,
  purchaseLabelForOrder,
  voidLabelForOrder,
} from "@/lib/shippo/service";
import { deactivatePackagePreset, getDefaultPackagePreset, setDefaultPackagePreset } from "@/lib/shippo/packages";

// ---------------------------------------------------------------- fixtures --

const ORDER_ID = "ord_1";
const PRESET_ID = "11111111-1111-4111-8111-111111111111";
const DOSE_ID = "22222222-2222-4222-8222-222222222222";

const USPS_RATE = {
  object_id: "rate_usps",
  amount: "5.20",
  currency: "USD",
  provider: "USPS",
  servicelevel: { name: "Ground Advantage", token: "usps_ground_advantage" },
  estimated_days: 3,
};

const UPS_RATE = {
  object_id: "rate_ups",
  amount: "11.45",
  currency: "USD",
  provider: "UPS",
  servicelevel: { name: "Ground", token: "ups_ground" },
  estimated_days: 2,
};

function seedOrder(overrides: Row = {}): Row {
  const order: Row = {
    id: "row-order",
    order_id: ORDER_ID,
    order_number: "VL-1001",
    order_type: "product",
    customer_name: "Dana Buyer",
    customer_email: "dana@example.com",
    shipping_address: "42 Test Ave",
    city: "Denver",
    state: "Colorado",
    postal_code: "80202",
    country: "United States",
    phone: "3035550111",
    payment_status: "paid",
    fulfillment_status: "ready_to_fulfill",
    tracking_number: null,
    shippo_shipment_id: null,
    shippo_transaction_id: null,
    shippo_rate_id: null,
    shipping_carrier: null,
    shipping_service: null,
    label_url: null,
    label_purchased_at: null,
    label_voided_at: null,
    label_purchase_claimed_at: null,
    postage_cost_cents: null,
    package_preset_id: PRESET_ID,
    parcel_weight_oz_override: null,
    packed_at: null,
    shipped_at: null,
    delivered_at: null,
    actual_shipping_cost_cents: null,
    shipping_cost_source: null,
    profit_finalized: false,
    ...overrides,
  };
  table("orders").push(order);
  return order;
}

function currentOrder(): Row {
  const order = table("orders").find((row) => row.order_id === ORDER_ID);
  if (!order) throw new Error("order missing");
  return order;
}

function seedPreset(): void {
  table("shipping_package_presets").push({
    id: PRESET_ID,
    name: "Standard Vanta Mailer",
    length_in: 9,
    width_in: 6,
    height_in: 3,
    empty_weight_oz: 1.5,
    is_default: true,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
}

function seedItems(): void {
  table("order_items").push(
    { order_id: ORDER_ID, product_id: `bpc-157-10mg::${DOSE_ID}`, product_name: "BPC-157", quantity: 2 },
    { order_id: ORDER_ID, product_id: "tb-500-5mg", product_name: "TB-500", quantity: 1 },
  );
  table("products").push(
    { slug: "bpc-157-10mg", shipping_weight_oz: 0.8 },
    { slug: "tb-500-5mg", shipping_weight_oz: 0.6 },
  );
  table("product_doses").push({ id: DOSE_ID, shipping_weight_oz: 1.25 });
}

function goodShipment() {
  return { ok: true as const, data: { shipmentId: "ship_1", rates: [USPS_RATE, UPS_RATE] } };
}


beforeEach(() => {
  // Vanta does not buy postage in production — labels are bought in Shippo and
  // synced back, so purchaseLabelForOrder refuses unless explicitly enabled.
  // These suites exercise the purchase MECHANICS (exactly-once, the claim, the
  // confirmed rate), which only mean anything with purchasing on. The default
  // refusal has its own suite below.
  process.env.SHIPPO_ALLOW_LABEL_PURCHASE = "true";
  resetTables();
  clearQuotedRateCache();
  vi.clearAllMocks();
  harness.state.originComplete = true;
  createShipmentWithRates.mockResolvedValue(goodShipment());
  voidLabel.mockResolvedValue({ ok: true, data: { refundId: "ref_1", transactionId: "txn_1", status: "QUEUED", pending: true } });
  recordActualShippingCost.mockResolvedValue({ ok: true });
  sendEmail.mockResolvedValue({ success: true });
  seedPreset();
  seedItems();
});

// ------------------------------------------------------------------ parcel --

describe("buildOrderParcel", () => {
  it("uses dose weight over product weight and adds the box tare exactly once", async () => {
    seedOrder();
    const result = await buildOrderParcel(ORDER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1.5 (mailer) + 2 x 1.25 (dose beats its product) + 1 x 0.6 = 4.6
    expect(result.data.weightOz).toBe(4.6);
    expect(result.data.parcel).toEqual({
      length: "9",
      width: "6",
      height: "3",
      distance_unit: "in",
      weight: "4.6",
      mass_unit: "oz",
    });
    expect(result.data.overridden).toBe(false);
  });

  it("lets an order-level override replace the whole computed total", async () => {
    seedOrder({ parcel_weight_oz_override: 12 });
    const result = await buildOrderParcel(ORDER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.weightOz).toBe(12);
    expect(result.data.overridden).toBe(true);
  });

  it("refuses a membership order rather than quoting a parcel for it", async () => {
    seedOrder({ order_type: "membership" });
    const result = await buildOrderParcel(ORDER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_shippable");
  });
});

// ------------------------------------------------------------------- rates --

describe("getRatesForOrder", () => {
  it("quotes against the configured origin and persists the shipment id", async () => {
    seedOrder();
    const result = await getRatesForOrder(ORDER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.rates).toHaveLength(2);
    expect(currentOrder().shippo_shipment_id).toBe("ship_1");

    const [request] = createShipmentWithRates.mock.calls[0] as [
      { addressTo: { state: string; country: string; email?: string } },
    ];
    // "Colorado" and "United States" have to reach Shippo as "CO" and "US".
    expect(request.addressTo.state).toBe("CO");
    expect(request.addressTo.country).toBe("US");
    // The buyer's email is deliberately withheld: shipping mail comes from us.
    expect(request.addressTo.email).toBeUndefined();
  });

  it("blocks the quote when the ship-from address is incomplete", async () => {
    harness.state.originComplete = false;
    seedOrder();
    const result = await getRatesForOrder(ORDER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("origin_incomplete");
    expect(createShipmentWithRates).not.toHaveBeenCalled();
  });

  it("names the missing field when the destination cannot be shipped to", async () => {
    seedOrder({ state: "", postal_code: "" });
    const result = await getRatesForOrder(ORDER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("destination_incomplete");
    expect(result.message).toContain("postal code");
    expect(result.message).toContain("state");
  });
});

// ------------------------------------------------------- label: exactly once --


// ------------------------------------------------------------ label: money --


/**
 * Put an order into the "label bought" state.
 *
 * Labels are purchased in Shippo's dashboard now, so this app never creates
 * that state itself — the transaction_created webhook reports it after the
 * fact. Seeding the row directly is therefore the honest fixture: it is exactly
 * what the webhook writes, without pretending this code did the buying.
 */
function seedPurchasedLabel(overrides: Row = {}): void {
  const order = currentOrder();
  Object.assign(order, {
    shippo_transaction_id: "transaction_test_1",
    shippo_rate_id: USPS_RATE.object_id,
    tracking_number: "9400111899223197428490",
    shipping_carrier: "USPS",
    shipping_service: "Ground Advantage",
    label_url: "https://shippo-delivery.s3.amazonaws.com/label.pdf",
    label_purchased_at: new Date().toISOString(),
    label_voided_at: null,
    postage_cost_cents: 520,
    actual_shipping_cost_cents: 520,
    shipping_cost_source: "shippo",
    profit_finalized: true,
    fulfillment_status: "label_purchased",
    label_purchase_claimed_at: new Date().toISOString(),
    ...overrides,
  });
}

// ------------------------------------------------------------------- void ---

describe("voidLabelForOrder", () => {
  async function buyThenVoid() {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();
    return voidLabelForOrder(ORDER_ID, "owner");
  }

  it("reverses the recorded cost instead of writing a zero", async () => {
    const result = await buyThenVoid();
    expect(result.ok).toBe(true);

    const order = currentOrder();
    expect(order.postage_cost_cents).toBeNull();
    // "Unknown", not "$0.00" — the UI must show Pending and fall back to the
    // estimate, which is exactly what an un-finalized profit does.
    expect(order.actual_shipping_cost_cents).toBeNull();
    expect(order.profit_finalized).toBe(false);
    expect(order.shipping_cost_source).toBeNull();
  });

  it("strips the label and tracking, steps back to packed and frees the claim", async () => {
    const result = await buyThenVoid();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.refundPending).toBe(true);

    const order = currentOrder();
    expect(order.label_url).toBeNull();
    expect(order.tracking_number).toBeNull();
    expect(order.label_voided_at).not.toBeNull();
    expect(order.fulfillment_status).toBe("packed");
    expect(order.label_purchase_claimed_at).toBeNull();
  });

  // After a void the owner buys a corrected label in Shippo, and the webhook
  // reports it. The void must not leave anything that blocks that second label
  // from landing — notably a stuck claim or a sticky label_voided_at.
  it("accepts a corrected label after a void", async () => {
    await buyThenVoid();

    seedPurchasedLabel({ shippo_transaction_id: "txn_2", postage_cost_cents: 745 });

    expect(currentOrder().shippo_transaction_id).toBe("txn_2");
    expect(currentOrder().postage_cost_cents).toBe(745);
    expect(currentOrder().label_voided_at).toBeNull();
  });

  it("treats a second void as a double-click, not an error or a second refund", async () => {
    await buyThenVoid();
    voidLabel.mockClear();

    const second = await voidLabelForOrder(ORDER_ID, "owner");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.alreadyVoided).toBe(true);
    expect(voidLabel).not.toHaveBeenCalled();
  });

  it("changes nothing when Shippo refuses the refund", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();

    voidLabel.mockResolvedValueOnce({
      ok: false,
      kind: "rejected",
      message: "Shippo could not void this label.",
      safeToRetry: false,
    });

    const result = await voidLabelForOrder(ORDER_ID, "owner");
    expect(result.ok).toBe(false);

    const order = currentOrder();
    expect(order.label_voided_at).toBeNull();
    expect(order.label_url).not.toBeNull();
    expect(order.postage_cost_cents).toBe(520);
  });
});

// ----------------------------------------------------------------- reprint --

describe("getLabelUrlForOrder", () => {
  it("returns the stored label and never re-purchases", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();

    const first = await getLabelUrlForOrder(ORDER_ID);
    const second = await getLabelUrlForOrder(ORDER_ID);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const stored = currentOrder().label_url;
    expect(first.data.labelUrl).toBe(stored);
    expect(second.data.labelUrl).toBe(stored);
    // Reprint reads the stored label. Nothing in this app can buy one.
  });

  it("refuses to hand back a voided label", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();
    await voidLabelForOrder(ORDER_ID, "owner");

    const result = await getLabelUrlForOrder(ORDER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("label_voided");
  });

  it("reports no_label for an order that was never labelled", async () => {
    seedOrder();
    const result = await getLabelUrlForOrder(ORDER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_label");
  });
});

// --------------------------------------------------------------- tracking ---

function trackingEvent(status: string, statusDate: string, overrides: Record<string, unknown> = {}) {
  return {
    event: "track_updated",
    data: {
      tracking_number: "9400111899223197428490",
      carrier: "usps",
      transaction: "txn_1",
      tracking_status: { status, status_details: "", status_date: statusDate },
      ...overrides,
    },
  } as Parameters<typeof applyTrackingUpdate>[0];
}

async function orderWithLabel(fulfillmentStatus = "label_purchased"): Promise<void> {
  seedOrder({
    fulfillment_status: fulfillmentStatus,
    shippo_transaction_id: "txn_1",
    tracking_number: "9400111899223197428490",
    shipping_carrier: "USPS",
    shipping_service: "Ground Advantage",
    label_url: "https://shippo-delivery.s3.amazonaws.com/label.pdf",
    label_purchased_at: "2026-08-01T00:00:00.000Z",
    label_purchase_claimed_at: "2026-08-01T00:00:00.000Z",
    postage_cost_cents: 520,
  });
}

describe("applyTrackingUpdate — idempotency", () => {
  it("drops a redelivered event without re-running anything", async () => {
    await orderWithLabel();

    const first = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    const second = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.data.statusChanged).toBe(true);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.statusChanged).toBe(false);
    // One email, one history row, however many times Shippo redelivers.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(table("order_status_history")).toHaveLength(1);
  });

  it("builds a key that distinguishes a genuinely new scan from a redelivery", () => {
    const same = buildTrackingEventKey(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    const redelivery = buildTrackingEventKey(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    const laterScan = buildTrackingEventKey(trackingEvent("TRANSIT", "2026-08-03T10:00:00Z"));
    const differentStatus = buildTrackingEventKey(trackingEvent("DELIVERED", "2026-08-02T10:00:00Z"));

    expect(same).toBe(redelivery);
    expect(laterScan).not.toBe(same);
    expect(differentStatus).not.toBe(same);
  });

  it("lets a retry work when the event arrives before the order is findable", async () => {
    // No order row matches this transaction yet.
    seedOrder({ shippo_transaction_id: null, tracking_number: null });

    const early = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    expect(early.ok).toBe(true);
    if (!early.ok) return;
    expect(early.data.reason).toBe("order_not_found");
    // The key was released, so Shippo's retry is not a permanent no-op.
    expect(table("shippo_webhook_events")).toHaveLength(0);

    Object.assign(currentOrder(), {
      shippo_transaction_id: "txn_1",
      tracking_number: "9400111899223197428490",
      fulfillment_status: "label_purchased",
      shipping_carrier: "USPS",
    });

    const retry = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.statusChanged).toBe(true);
  });
});

describe("applyTrackingUpdate — out of order", () => {
  it("never un-delivers a delivered order", async () => {
    await orderWithLabel();

    await applyTrackingUpdate(trackingEvent("DELIVERED", "2026-08-04T09:00:00Z"));
    expect(currentOrder().fulfillment_status).toBe("delivered");
    expect(currentOrder().delivered_at).not.toBeNull();

    // A TRANSIT scan that took the scenic route through Shippo's queue.
    const late = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-03T09:00:00Z"));
    expect(late.ok).toBe(true);
    if (!late.ok) return;

    expect(late.data.statusChanged).toBe(false);
    expect(late.data.reason).toBe("terminal");
    expect(currentOrder().fulfillment_status).toBe("delivered");
  });

  it("does not walk back from out_for_delivery to in_transit", async () => {
    await orderWithLabel();

    await applyTrackingUpdate(trackingEvent("OUT_FOR_DELIVERY", "2026-08-04T08:00:00Z"));
    expect(currentOrder().fulfillment_status).toBe("out_for_delivery");

    const stale = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-03T08:00:00Z"));
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.data.reason).toBe("regression");
    expect(currentOrder().fulfillment_status).toBe("out_for_delivery");
  });

  it("ignores a status Shippo never documented rather than writing it", async () => {
    await orderWithLabel();
    const result = await applyTrackingUpdate(trackingEvent("EXPLODED", "2026-08-04T08:00:00Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reason).toBe("unknown_tracking_status");
    expect(currentOrder().fulfillment_status).toBe("label_purchased");
    expect(table("shippo_webhook_events")).toHaveLength(0);
  });
});

describe("applyTrackingUpdate — customer email", () => {
  it("sends exactly two emails across a whole delivery, however many scans arrive", async () => {
    // The regression: every status earned its own email, so an ordinary
    // delivery sent four — shipped, in transit, out for delivery, delivered.
    // The webhook dedupe cannot catch that; they are four genuinely different
    // scans. The customer just experiences it as spam.
    await orderWithLabel();

    await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // A second TRANSIT scan from a different facility: new event key, same
    // status. Nothing changes, so nothing is sent.
    const repeat = await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T18:00:00Z"));
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    expect(repeat.data.reason).toBe("unchanged");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // A real status change, but the parcel was already in the carrier's hands.
    // The customer has been told; telling them again says nothing new.
    await applyTrackingUpdate(trackingEvent("OUT_FOR_DELIVERY", "2026-08-03T08:00:00Z"));
    expect(sendEmail).toHaveBeenCalledTimes(1);

    await applyTrackingUpdate(trackingEvent("DELIVERED", "2026-08-03T15:00:00Z"));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("links Track Package to the carrier's own page, not a provider's site", async () => {
    await orderWithLabel();
    await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));

    const [message] = sendEmail.mock.calls[0] as unknown as [{ to: string; html: string; subject: string }];
    expect(message.to).toBe("dana@example.com");
    expect(message.html).toContain("https://tools.usps.com/go/TrackConfirmAction");
    expect(message.html).toContain("USPS");
    // Nothing in a Vanta Labs email may point at a fulfilment provider.
    expect(message.html).not.toContain("goshippo.com");
  });

  it("sends the delivery template, not a shipping update, on delivery", async () => {
    await orderWithLabel("in_transit");
    await applyTrackingUpdate(trackingEvent("DELIVERED", "2026-08-03T15:00:00Z"));

    const [message] = sendEmail.mock.calls[0] as [{ subject: string }];
    expect(message.subject).toContain("Delivered");
    expect(currentOrder().delivered_at).not.toBeNull();
  });

  it("stamps shipped_at once and mirrors tracking into order_shipments", async () => {
    await orderWithLabel();

    await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    const firstShippedAt = currentOrder().shipped_at;
    expect(firstShippedAt).not.toBeNull();

    await applyTrackingUpdate(trackingEvent("OUT_FOR_DELIVERY", "2026-08-03T08:00:00Z"));
    expect(currentOrder().shipped_at).toBe(firstShippedAt);

    const shipments = table("order_shipments");
    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({
      order_id: ORDER_ID,
      tracking_number: "9400111899223197428490",
      shipping_status: "out_for_delivery",
    });
  });

  // A shipping notice used to reach the provider with NO idempotency key, so a
  // provider that accepted the message but timed out answering, followed by the
  // queued retry, put two "shipped" emails in the inbox. Each notice now goes
  // out under one stable key per (order, kind), and the queue row carries the
  // same identity so the sweep re-sends under that key.
  it("sends the shipped and delivered notices under one stable idempotency key each", async () => {
    await orderWithLabel();
    await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));
    await applyTrackingUpdate(trackingEvent("DELIVERED", "2026-08-03T15:00:00Z"));

    const keys = sendEmail.mock.calls.map((call) => (call[0] as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual([`order_shipped:${ORDER_ID}`, `order_delivered:${ORDER_ID}`]);
  });

  it("a refused shipped notice is queued WITH its identity, so the retry reuses the key", async () => {
    await orderWithLabel();
    sendEmail.mockResolvedValueOnce({ success: false, error: "provider down" });

    await applyTrackingUpdate(trackingEvent("TRANSIT", "2026-08-02T10:00:00Z"));

    const queued = table("pending_emails");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ to_email: "dana@example.com", order_id: ORDER_ID, email_kind: "order_shipped", status: "pending" });
  });

  it("ignores an event type it does not handle without claiming a key", async () => {
    await orderWithLabel();
    const result = await applyTrackingUpdate({
      event: "transaction_created",
      data: { tracking_number: "9400111899223197428490", tracking_status: { status: "TRANSIT" } },
    } as Parameters<typeof applyTrackingUpdate>[0]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reason).toBe("unsupported_event");
    expect(table("shippo_webhook_events")).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------- packages ---

describe("package presets", () => {
  it("keeps exactly one default when a new box is promoted", async () => {
    const second = "33333333-3333-4333-8333-333333333333";
    table("shipping_package_presets").push({
      id: second,
      name: "Large Box",
      length_in: 12,
      width_in: 10,
      height_in: 6,
      empty_weight_oz: 4,
      is_default: false,
      is_active: true,
    });

    const promoted = await setDefaultPackagePreset(second);
    expect(promoted.ok).toBe(true);

    const defaults = table("shipping_package_presets").filter((row) => row.is_default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second);
  });

  it("hands the default on when the default box is retired", async () => {
    const second = "33333333-3333-4333-8333-333333333333";
    table("shipping_package_presets").push({
      id: second,
      name: "Large Box",
      length_in: 12,
      width_in: 10,
      height_in: 6,
      empty_weight_oz: 4,
      is_default: false,
      is_active: true,
    });

    await deactivatePackagePreset(PRESET_ID);

    const fallback = await getDefaultPackagePreset();
    expect(fallback?.id).toBe(second);
    expect(table("shipping_package_presets").filter((row) => row.is_default === true)).toHaveLength(1);
  });
});

// ===========================================================================
// THE MONEY PATH.
//
// purchaseLabelForOrder is the only function in this application that spends
// the owner's money, and it was restored deliberately so Vanta — not Shippo's
// dashboard — is where postage gets bought.
//
// THE INVARIANT, stated once: ONE ORDER MUST NEVER BUY TWO ACTIVE LABELS.
// Every test below is that sentence under a different kind of pressure. Where
// certainty is impossible, the required behaviour is to STOP and surface an
// exception — never to guess by trying again.
// ===========================================================================
/**
 * THE STANDING RULE, PROVEN AT THE MONEY BOUNDARY.
 *
 * Vanta does not buy postage — labels are purchased in Shippo and synced back.
 * Every other suite in this file sets SHIPPO_ALLOW_LABEL_PURCHASE=true because
 * it is testing purchase MECHANICS. This one removes it, which is the shape
 * production actually runs in, and proves nothing reaches Shippo.
 *
 * Asserting the refusal alone would be too weak: what matters is that no HTTP
 * call to /transactions/ is made and no claim is left behind for a human to
 * clear.
 */
describe("purchaseLabelForOrder — Vanta does not buy postage", () => {
  const KEY = "SHIPPO_ALLOW_LABEL_PURCHASE";

  it("refuses, spends nothing, and takes no claim", async () => {
    delete process.env[KEY];
    purchaseLabel.mockResolvedValue({
      ok: true,
      data: { transactionId: "txn_should_not_happen", labelUrl: "https://x", trackingNumber: "1Z", rate: null },
    });

    const seeded = seedOrder();

    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true }, actor: "owner" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("purchasing_disabled");
    // The whole point: no money left the account.
    expect(purchaseLabel).not.toHaveBeenCalled();
    // And no claim was taken, so nobody has to clear a stuck row by hand.
    expect(seeded.label_purchase_claimed_at ?? null).toBeNull();
  });

  it("still hands back a label the order ALREADY has, so printing keeps working", async () => {
    delete process.env[KEY];
    seedOrder({
      shippo_transaction_id: "txn_existing",
      label_url: "https://label.goshippo.com/existing.pdf",
      tracking_number: "1Z-EXISTING",
    });

    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });

    expect(result.ok).toBe(true);
    expect(purchaseLabel).not.toHaveBeenCalled();
  });
});

describe("purchaseLabelForOrder — exactly once", () => {
  /** A successful Shippo purchase. */
  function shippoSucceeds(overrides: Record<string, unknown> = {}) {
    purchaseLabel.mockResolvedValue({
      ok: true,
      data: {
        transactionId: "transaction_bought_1",
        rateId: USPS_RATE.object_id,
        trackingNumber: "9400111899223197428490",
        labelUrl: "https://shippo-delivery.s3.amazonaws.com/label.pdf",
        trackingUrlProvider: null,
        carrier: "USPS",
        service: "Ground Advantage",
        serviceToken: "usps_ground_advantage",
        postageCostCents: 520,
        raw: {},
        ...overrides,
      },
    });
  }

  async function quoted() {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
  }

  it("buys once and records the transaction, tracking, carrier and exact cost", async () => {
    await quoted();
    shippoSucceeds();

    const result = await purchaseLabelForOrder({
      orderId: ORDER_ID,
      selection: { cheapest: true },
      actor: "owner",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reused).toBe(false);
    expect(result.data.postageCostCents).toBe(520);
    expect(purchaseLabel).toHaveBeenCalledTimes(1);

    const order = currentOrder();
    expect(order.shippo_transaction_id).toBe("transaction_bought_1");
    expect(order.tracking_number).toBe("9400111899223197428490");
    expect(order.shipping_carrier).toBe("USPS");
    expect(order.postage_cost_cents).toBe(520);
    // Through the canonical pipeline, not a raw write.
    expect(order.fulfillment_status).toBe("label_purchased");
    expect(recordActualShippingCost).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 520, source: "shippo" }),
    );
  });

  it("writes fulfillment history rather than bypassing it", async () => {
    await quoted();
    shippoSucceeds();
    await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true }, actor: "owner" });

    const history = table("order_status_history").filter((r) => r.order_id === ORDER_ID);
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((r) => r.to_status === "label_purchased")).toBe(true);
  });

  it("REFUSES to buy without an explicit selection", async () => {
    await quoted();
    shippoSucceeds();
    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: {}, actor: "owner" });
    expect(result.ok).toBe(false);
    // Nothing was bought, and no claim was taken.
    expect(purchaseLabel).not.toHaveBeenCalled();
    expect(currentOrder().label_purchase_claimed_at ?? null).toBeNull();
  });

  it("a SECOND request returns the same label and does not call Shippo again", async () => {
    await quoted();
    shippoSucceeds();
    const first = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    const second = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });

    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.reused).toBe(true);
    expect(second.data.transactionId).toBe("transaction_bought_1");
    // THE INVARIANT.
    expect(purchaseLabel).toHaveBeenCalledTimes(1);
  });

  it("a DOUBLE-CLICK — two concurrent requests — buys exactly one label", async () => {
    await quoted();
    shippoSucceeds();

    const [a, b] = await Promise.all([
      purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } }),
      purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } }),
    ]);

    expect(purchaseLabel).toHaveBeenCalledTimes(1);
    // Exactly one wins; the loser is told a purchase is in flight rather than
    // being handed a second charge.
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.code));
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes).toContain("purchase_in_progress");
  });

  it("FIVE simultaneous tabs still buy exactly one label", async () => {
    await quoted();
    shippoSucceeds();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } }),
      ),
    );

    expect(purchaseLabel).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("sends Shippo an idempotency key derived from the ORDER", async () => {
    await quoted();
    shippoSucceeds();
    await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });

    const [input] = purchaseLabel.mock.calls[0] as [{ idempotencyKey?: string; metadata?: string }];
    // Keyed on the order ID, so even a defeated local claim cannot create a
    // second transaction at Shippo. This stays on the immutable internal id —
    // an order number could in principle be reissued, and the idempotency key
    // must never move.
    expect(input.idempotencyKey).toBe(`vanta-label-${ORDER_ID}`);

    // METADATA IS THE ORDER NUMBER, AND THIS ASSERTION USED TO DEMAND THE ID.
    //
    // It was pinning a real defect. resolveOrderFromShippo matches this field
    // back with .eq("order_number", metadata), so sending the id meant that
    // fallback could never resolve anything Vanta had purchased — writer and
    // reader disagreed on the format, and each looked correct alone.
    //
    // It is also the string the owner reads in the Shippo dashboard when they
    // go to print. VL-1001 identifies the order; order-3f8a… is noise.
    expect(input.metadata).toBe(currentOrder().order_number);
    expect(input.metadata).not.toBe(ORDER_ID);
  });

  it("refuses when a previous purchase's outcome is still unknown", async () => {
    await quoted();
    currentOrder().label_purchase_claimed_at = new Date().toISOString();

    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("purchase_in_progress");
    expect(purchaseLabel).not.toHaveBeenCalled();
  });

  it("never buys for an order that already shipped", async () => {
    await quoted();
    seedPurchasedLabel({ fulfillment_status: "in_transit" });
    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    // Short-circuits on the existing label; no second charge.
    expect(result.ok).toBe(true);
    expect(purchaseLabel).not.toHaveBeenCalled();
  });
});

describe("purchaseLabelForOrder — failure is never a retry", () => {
  async function quoted() {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
  }

  it("a DEFINITIVE rejection frees the claim so a corrected attempt can proceed", async () => {
    await quoted();
    purchaseLabel.mockResolvedValue({
      ok: false,
      kind: "rejected",
      message: "Shippo could not buy this label.",
      // Shippo's own statement that nothing was created.
      safeToRetry: true,
    });

    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(result.ok).toBe(false);
    // Safe to try again — nothing was charged.
    expect(currentOrder().label_purchase_claimed_at ?? null).toBeNull();
  });

  it("a TIMEOUT keeps the claim, so the order stops rather than buying twice", async () => {
    await quoted();
    purchaseLabel.mockResolvedValue({
      ok: false,
      kind: "timeout",
      message: "Shippo did not respond within 30 seconds.",
      // The request may have been fully processed before the connection died.
      safeToRetry: false,
    });

    const first = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(first.ok).toBe(false);
    // THE CLAIM IS HELD. This is the whole point.
    expect(currentOrder().label_purchase_claimed_at ?? null).not.toBeNull();

    // And a retry is refused rather than gambling a second charge.
    purchaseLabel.mockClear();
    const retry = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.code).toBe("purchase_in_progress");
    expect(purchaseLabel).not.toHaveBeenCalled();
  });

  it("a LOST RESPONSE after Shippo charged keeps the claim too", async () => {
    await quoted();
    purchaseLabel.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "Could not reach Shippo.",
      safeToRetry: false,
    });

    await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(currentOrder().label_purchase_claimed_at ?? null).not.toBeNull();
    expect(currentOrder().shippo_transaction_id ?? null).toBeNull();
  });

  it("a 2xx with no transaction id is treated as ambiguous, not as success", async () => {
    await quoted();
    purchaseLabel.mockResolvedValue({
      ok: false,
      kind: "invalid_response",
      message: "Shippo accepted the purchase but did not return a transaction id.",
      safeToRetry: false,
    });

    const result = await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { cheapest: true } });
    expect(result.ok).toBe(false);
    expect(currentOrder().label_purchase_claimed_at ?? null).not.toBeNull();
  });

  it("an EXPIRED RATE fails before claiming and before spending", async () => {
    seedOrder();
    // No quote at all, and a rate id that resolves to nothing.
    createShipmentWithRates.mockResolvedValue({
      ok: false,
      kind: "rejected",
      message: "no rates",
      safeToRetry: true,
    });

    const result = await purchaseLabelForOrder({
      orderId: ORDER_ID,
      selection: { rateId: "rate_that_expired" },
    });
    expect(result.ok).toBe(false);
    expect(purchaseLabel).not.toHaveBeenCalled();
    // No claim was taken, so the order is not stranded by a failed lookup.
    expect(currentOrder().label_purchase_claimed_at ?? null).toBeNull();
  });

  it("a rate quoted for ANOTHER order can never be purchased against this one", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    const rateId = String(USPS_RATE.object_id);
    // Same rate id, different order.
    const other = await purchaseLabelForOrder({
      orderId: "vl-some-other-order",
      selection: { rateId },
    });
    expect(other.ok).toBe(false);
    expect(purchaseLabel).not.toHaveBeenCalled();
  });
});

describe("purchaseLabelForOrder — reprint and void", () => {
  it("reprinting returns the stored label and never calls Shippo", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();

    const printed = await getLabelUrlForOrder(ORDER_ID);
    expect(printed.ok).toBe(true);
    // Reprinting is a printing problem, not a purchase.
    expect(purchaseLabel).not.toHaveBeenCalled();
  });

  it("a voided label frees the claim so a replacement can be bought", async () => {
    seedOrder();
    await getRatesForOrder(ORDER_ID);
    seedPurchasedLabel();
    voidLabel.mockResolvedValue({
      ok: true,
      data: { refundId: "refund_1", transactionId: "transaction_test_1", status: "QUEUED", pending: true },
    });

    await voidLabelForOrder(ORDER_ID, "owner");
    expect(currentOrder().label_purchase_claimed_at ?? null).toBeNull();
    expect(currentOrder().shippo_transaction_id).toBe("transaction_test_1");
    expect(currentOrder().label_voided_at).not.toBeNull();
  });
});

// ===========================================================================
// DEFECT: THE CONFIRMED PRICE AND THE CHARGED PRICE COULD DIVERGE.
//
// The batch flow quotes every order, shows the operator a total, and asks them
// to confirm it. The purchase then ran with `{ cheapest: true }` and NO rate id,
// which skips the quoted-rate cache entirely and re-quotes. Whatever came back
// cheapest at that moment was bought — so the number on the confirmation dialog
// was not necessarily the number charged.
//
// The fix carries the reviewed rate id through to the purchase. These tests pin
// that the id is honoured and that a re-quote cannot substitute a different
// rate behind the operator's back.
// ===========================================================================
describe("purchaseLabelForOrder — buys the rate that was confirmed", () => {
  it("uses the quoted rate id instead of re-quoting", async () => {
    seedOrder();
    const quote = await getRatesForOrder(ORDER_ID);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    const reviewedRateId = String(quote.data.rates[0].object_id);
    const callsAfterQuote = createShipmentWithRates.mock.calls.length;

    purchaseLabel.mockResolvedValue({
      ok: true,
      data: {
        transactionId: "transaction_confirmed", rateId: reviewedRateId,
        trackingNumber: "94001", labelUrl: "https://shippo-delivery.s3.amazonaws.com/l.pdf",
        trackingUrlProvider: null, carrier: "USPS", service: "Ground Advantage",
        serviceToken: "usps_ground_advantage", postageCostCents: 520, raw: {},
      },
    });

    await purchaseLabelForOrder({ orderId: ORDER_ID, selection: { rateId: reviewedRateId } });

    // THE ASSERTION THAT FAILED BEFORE THE FIX: with a cached rate id the
    // purchase must not go back to Shippo for a fresh quote.
    expect(createShipmentWithRates.mock.calls.length).toBe(callsAfterQuote);
    const [input] = purchaseLabel.mock.calls[0] as [{ rate: { object_id: string } }];
    expect(input.rate.object_id).toBe(reviewedRateId);
  });

  it("charges the price the operator was shown, not a later one", async () => {
    seedOrder();
    const quote = await getRatesForOrder(ORDER_ID);
    if (!quote.ok) return;
    const reviewed = quote.data.rates[0];
    const reviewedCents = Math.round(Number(reviewed.amount) * 100);

    // Shippo re-prices between review and purchase — a surcharge, a carrier
    // dropping out, anything. A re-quoting purchase would silently buy this.
    createShipmentWithRates.mockResolvedValue({
      ok: true,
      data: {
        shipmentId: "ship_2",
        rates: [{ ...reviewed, object_id: "rate_more_expensive", amount: "99.00" }],
      },
    });

    purchaseLabel.mockImplementation(async (input: { rate: { object_id: string; amount: string } }) => ({
      ok: true,
      data: {
        transactionId: "transaction_x", rateId: input.rate.object_id,
        trackingNumber: "94001", labelUrl: "https://shippo-delivery.s3.amazonaws.com/l.pdf",
        trackingUrlProvider: null, carrier: "USPS", service: "Ground Advantage",
        serviceToken: "usps_ground_advantage",
        postageCostCents: Math.round(Number(input.rate.amount) * 100), raw: {},
      },
    }));

    const result = await purchaseLabelForOrder({
      orderId: ORDER_ID,
      selection: { rateId: String(reviewed.object_id) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The confirmed price, not the $99 re-quote.
    expect(result.data.postageCostCents).toBe(reviewedCents);
  });
});
