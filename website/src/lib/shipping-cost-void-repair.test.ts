import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A VOIDED LABEL MUST NOT BE RE-CHARGED BY THE SWEEP.
//
// voidLabelForOrder refunds the postage at Shippo and then clears
// postage_cost_cents / label_url / tracking_number and stamps label_voided_at.
// reverseRecordedShippingCost nulls actual_shipping_cost_cents and drops
// profit_finalized. But label_purchased_at and shippo_transaction_id are KEPT
// deliberately — they are facts about a label that really was bought.
//
// That leaves a row matching the repair sweep's old predicate EXACTLY: a
// purchased label, a live Shippo transaction id, no recorded cost. The next
// tick re-read the still-present Shippo rate, re-wrote the refunded postage,
// and flipped profit_finalized back to true. shouldWriteShippingAudit then
// suppressed the audit row because that amount was already in the history, so
// the re-charge left NO trace at all.
//
// This file drives the REAL repairMissingShippingCosts against the REAL
// recordActualShippingCost over an in-memory orders/audit store, seeded to the
// exact state a void leaves behind. Nothing about the money path is stubbed.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: { orders: Row[]; order_items: Row[]; commissions: Row[]; order_shipping_cost_audit: Row[] } = {
  orders: [],
  order_items: [],
  commissions: [],
  order_shipping_cost_audit: [],
};

const shippo = vi.hoisted(() => ({
  getTransaction: vi.fn(async () => ({
    ok: true as const,
    data: { object_id: "txn-1", status: "SUCCESS", rate: { amount: "7.42", currency: "USD" } },
  })),
  settledCentsFromTransaction: vi.fn(() => 742),
  recordSystemAlert: vi.fn(async (_alert: { type: string; severity: string; message: string }) => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/shippo/client", () => ({
  getTransaction: shippo.getTransaction,
  settledCentsFromTransaction: shippo.settledCentsFromTransaction,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: shippo.recordSystemAlert }));
vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    minProfitPercent: 20,
    minProfitDollars: 5,
    worstCaseUnitCost: 30,
    processingFeePercent: 8,
    processingFeeIncludesTax: true,
    countSalesTaxAsProfit: false,
    shippingCostPerOrder: 6,
  }),
}));

// A small in-memory PostgREST. Filters, ordering, paging, updates and inserts
// all actually apply, so a query that fails to exclude a row genuinely returns
// it — which is the whole point of the test below.
vi.mock("@/lib/supabase-server", () => {
  function tableFor(name: string): Row[] {
    const rows = (db as Record<string, Row[]>)[name];
    if (!rows) throw new Error(`unexpected table in test: ${name}`);
    return rows;
  }

  function builder(name: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let action: "select" | "update" | "delete" = "select";
    let patch: Row = {};
    let sort: { col: string; asc: boolean } | null = null;
    let take: number | null = null;
    let slice: [number, number] | null = null;

    const matched = () => tableFor(name).filter((row) => filters.every((f) => f(row)));

    function settle() {
      const rows = matched();
      if (action === "update") {
        for (const row of rows) Object.assign(row, patch);
        return { data: rows.map((row) => ({ ...row })), error: null };
      }
      let out = rows.map((row) => ({ ...row }));
      if (sort) {
        const { col, asc } = sort;
        out.sort((a, b) => {
          const x = String(a[col] ?? "");
          const y = String(b[col] ?? "");
          return asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (slice) out = out.slice(slice[0], slice[1] + 1);
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      update(next: Row) { action = "update"; patch = next; return b; },
      insert(next: Row | Row[]) {
        const list = Array.isArray(next) ? next : [next];
        for (const row of list) tableFor(name).push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      neq(col: string, value: unknown) { filters.push((row) => row[col] !== value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      not(col: string, op: string, value: unknown) {
        if (op !== "is" || value !== null) throw new Error(`unsupported .not(${op})`);
        filters.push((row) => (row[col] ?? null) !== null);
        return b;
      },
      gte(col: string, value: unknown) {
        filters.push((row) => String(row[col] ?? "") >= String(value));
        return b;
      },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return b; },
      order(col: string, opts?: { ascending?: boolean }) {
        sort = { col, asc: opts?.ascending !== false };
        return b;
      },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) { slice = [from, to]; return b; },
      async maybeSingle() {
        const { data } = settle();
        return { data: (data as Row[])[0] ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }

  return { supabaseAdmin: { from: (name: string) => builder(name) } };
});

import { recordActualShippingCost, getShippingCostAudit } from "@/lib/admin-profit";
import { repairMissingShippingCosts } from "@/lib/shipping-cost-repair";

const ORDER_ID = "order-void-1";

/** An order that bought a real label at $7.42 and had that cost recorded. */
function seedLabelledOrder() {
  db.orders = [{
    order_id: ORDER_ID,
    order_number: "VL-VOID001",
    order_type: "product",
    subtotal: 100,
    discount_amount: 0,
    shipping_amount: 0,
    tax_amount: 0,
    refund_amount: 0,
    amount_paid: 100,
    payment_method: "card",
    payment_status: "paid",
    paid_at: "2026-08-20T00:00:00Z",
    created_at: "2026-08-20T00:00:00Z",
    shipping_protection_fee: 0,
    card_processing_fee: 0,
    store_credit_redeemed_cents: 0,
    points_redeemed: 0,
    label_purchased_at: "2026-08-21T10:00:00Z",
    label_voided_at: null,
    shippo_transaction_id: "txn-1",
    postage_cost_cents: 742,
    actual_shipping_cost_cents: 742,
    estimated_shipping_cost_cents: 600,
    shipping_cost_source: "shippo",
    profit_finalized: true,
  }];
  db.order_items = [{ id: 1, order_id: ORDER_ID, quantity: 1, unit_cost_cents: 1000 }];
  db.commissions = [];
  db.order_shipping_cost_audit = [{
    id: "audit-1",
    order_id: ORDER_ID,
    estimated_cost_cents: 600,
    exact_cost_cents: 742,
    difference_cents: 142,
    source: "shippo",
    changed_by: null,
    created_at: "2026-08-21T10:00:01Z",
  }];
}

/**
 * The row state voidLabelForOrder + reverseRecordedShippingCost actually leave.
 * Copied field-for-field from service.ts: label_purchased_at and
 * shippo_transaction_id survive on purpose.
 */
function applyVoid() {
  const order = db.orders[0];
  order.label_voided_at = "2026-08-22T09:00:00Z";
  order.label_url = null;
  order.tracking_number = null;
  order.postage_cost_cents = null;
  order.label_purchase_claimed_at = null;
  order.actual_shipping_cost_cents = null;
  order.shipping_cost_source = null;
  order.profit_finalized = false;
  db.order_shipping_cost_audit.push({
    id: "audit-2",
    order_id: ORDER_ID,
    estimated_cost_cents: null,
    exact_cost_cents: null,
    difference_cents: null,
    source: "manual",
    changed_by: "admin",
    created_at: "2026-08-22T09:00:01Z",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedLabelledOrder();
});

describe("the shipping sweep after a label is voided", () => {
  it("leaves the cost NULL and writes no second audit row", async () => {
    applyVoid();
    const auditRowsBefore = db.order_shipping_cost_audit.length;

    const result = await repairMissingShippingCosts();

    // Nothing was even a candidate: the voided row is filtered out in the query.
    expect(result).toEqual({ scanned: 0, repaired: 0, failed: 0 });
    // The refunded postage stays refunded.
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
    expect(db.orders[0].profit_finalized).toBe(false);
    // No re-charge means no audit row — and no SILENT re-charge either, which
    // is what made this bug invisible in the first place.
    expect(db.order_shipping_cost_audit).toHaveLength(auditRowsBefore);
    // Shippo was never even asked for the rate.
    expect(shippo.getTransaction).not.toHaveBeenCalled();
  });

  it("still repairs an ordinary order that was never voided — the filter is not just switched off", async () => {
    // Positive control. Same harness, same sweep: only label_voided_at differs.
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].profit_finalized = false;
    db.orders[0].postage_cost_cents = null; // force the Shippo lookup path

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
    expect(db.orders[0].profit_finalized).toBe(true);
    expect(shippo.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("prefers the postage already on the order over a Shippo round-trip", async () => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].profit_finalized = false;
    // postage_cost_cents is still 742 from the label purchase.

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
    expect(shippo.getTransaction).not.toHaveBeenCalled();
  });
});

describe("recordActualShippingCost is the layer that cannot be bypassed", () => {
  it("refuses a voided order even when called directly, and writes nothing", async () => {
    applyVoid();
    const auditRowsBefore = db.order_shipping_cost_audit.length;

    const outcome = await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 742, source: "shippo" });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/voided/i);
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
    expect(db.orders[0].profit_finalized).toBe(false);
    expect(db.order_shipping_cost_audit).toHaveLength(auditRowsBefore);
  });

  it("records the cost normally on an order whose label is live", async () => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].profit_finalized = false;

    const outcome = await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 900, source: "manual" });

    expect(outcome.ok).toBe(true);
    expect(db.orders[0].actual_shipping_cost_cents).toBe(900);
    // 900 differs from the most recent audited value (742), so the change is
    // recorded rather than swallowed.
    const audit = await getShippingCostAudit(ORDER_ID);
    expect(audit[0].exactCostCents).toBe(900);
  });
});

describe("a Shippo transaction that is not SUCCESS", () => {
  it("is never charged to profit", async () => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].postage_cost_cents = null;
    db.orders[0].profit_finalized = false;
    shippo.getTransaction.mockResolvedValueOnce({
      ok: true as const,
      data: { object_id: "txn-1", status: "REFUNDED", rate: { amount: "7.42", currency: "USD" } },
    });

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 1, repaired: 0, failed: 1 });
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
    // A permanently unfixable row must not page the operator every half hour.
    const alerts = shippo.recordSystemAlert.mock.calls.map((call) => call[0]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].type).toBe("shipping_cost_manual_entry_required");
  });
});
