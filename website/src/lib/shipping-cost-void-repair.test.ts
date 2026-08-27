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

const db: {
  orders: Row[];
  order_items: Row[];
  commissions: Row[];
  order_shipping_cost_audit: Row[];
  system_alerts: Row[];
  /**
   * Reads that must fail the way PostgREST really fails: `{ data: null, error }`,
   * NOT a rejected promise. Keyed by the exact column list the query asks for,
   * so one specific read can be broken while the rest of the flow works.
   */
  failSelect: Record<string, { code: string; message: string }>;
} = {
  orders: [],
  order_items: [],
  commissions: [],
  order_shipping_cost_audit: [],
  system_alerts: [],
  failSelect: {},
};

const shippo = vi.hoisted(() => ({
  getTransaction: vi.fn(async () => ({
    ok: true as const,
    data: { object_id: "txn-1", status: "SUCCESS", rate: { amount: "7.42", currency: "USD" } },
  })),
  settledCentsFromTransaction: vi.fn(() => 742),
  // Writes the durable row the real one writes, so a second run genuinely
  // reads back what the first run reported.
  recordSystemAlert: vi.fn(async (alert: { type: string; severity: string; message: string; context?: unknown }) => {
    db.system_alerts.push({
      id: `alert-${db.system_alerts.length + 1}`,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      context: alert.context ?? {},
      resolved_at: null,
      created_at: new Date(Date.now() + db.system_alerts.length).toISOString(),
    });
  }),
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
    const rows = (db as unknown as Record<string, Row[]>)[name];
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
      if (action === "select" && db.failSelect[selectedColumns]) {
        return { data: null, error: db.failSelect[selectedColumns] };
      }
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

    let selectedColumns = "";

    const b: Record<string, unknown> = {
      select(cols?: string) { selectedColumns = String(cols ?? ""); return b; },
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
        const { data, error } = settle();
        if (error) return { data: null, error };
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

import { ORDER_FIELDS, recordActualShippingCost, getShippingCostAudit } from "@/lib/admin-profit";
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
  db.system_alerts = [];
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

  it("confirms the label is still live with Shippo, then takes the amount from the order", async () => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].profit_finalized = false;
    // postage_cost_cents is still 742 from the label purchase.

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
    // The status is asked for — that check is the ONLY thing standing between
    // an out-of-app void and a re-charge.
    expect(shippo.getTransaction).toHaveBeenCalledTimes(1);
    // ...but the amount is the one already on the order; the rate is not
    // re-parsed.
    expect(shippo.settledCentsFromTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A LABEL VOIDED IN THE SHIPPO DASHBOARD NEVER SETS label_voided_at HERE.
//
// The in-app void path stamps that column, and three layers key off it. A void
// raised at Shippo does not: the order still reads label_purchased_at set,
// label_voided_at NULL, postage_cost_cents 742 — and if recordActualShippingCost
// had failed when the label was bought, actual_shipping_cost_cents NULL too.
// That row matches this sweep exactly, and the refunded postage was charged to
// profit on the next tick. The transaction's STATUS is the only evidence that
// exists, and the sweep must actually look at it.
// ---------------------------------------------------------------------------
describe("a label voided outside this app, on an order that still holds its postage", () => {
  it("is not charged to profit", async () => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].profit_finalized = false;
    // The order still carries the figure written when the label was bought,
    // and label_voided_at is NULL because the void happened at Shippo.
    expect(db.orders[0].postage_cost_cents).toBe(742);
    expect(db.orders[0].label_voided_at).toBeNull();
    shippo.getTransaction.mockResolvedValueOnce({
      ok: true as const,
      data: { object_id: "txn-1", status: "REFUNDED", rate: { amount: "7.42", currency: "USD" } },
    });

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 1, repaired: 0, failed: 1 });
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
    expect(db.orders[0].profit_finalized).toBe(false);
    expect(db.order_shipping_cost_audit.filter((row) => row.exact_cost_cents === 742)).toHaveLength(1);
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

  // ------------------------------------------------------------------
  // ...BUT A HUMAN MUST STILL HAVE A LAST RESORT.
  //
  // A carrier void refund is often PENDING and can be DECLINED. When USPS
  // refuses it the store really did pay that postage, and with the sweep
  // filtering voided rows out and this function refusing every caller, there
  // was no path left to record it at all — while the sweep's own alert told
  // the operator to "enter the cost by hand in Admin -> Orders".
  // ------------------------------------------------------------------
  it("accepts a deliberate manual override for a void refund the carrier declined", async () => {
    applyVoid();

    const outcome = await recordActualShippingCost({
      orderId: ORDER_ID,
      amountCents: 742,
      source: "manual",
      changedBy: "admin",
      overrideVoidedLabel: true,
    });

    expect(outcome.ok).toBe(true);
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
    expect(db.orders[0].shipping_cost_source).toBe("manual");
  });

  it("still refuses the AUTOMATED path even if it asks to override", async () => {
    applyVoid();

    // The sweep and the Shippo webhook both record with source "shippo". The
    // override is a human's, and cannot be borrowed by a machine.
    const outcome = await recordActualShippingCost({
      orderId: ORDER_ID,
      amountCents: 742,
      source: "shippo",
      overrideVoidedLabel: true,
    });

    expect(outcome.ok).toBe(false);
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
  });

  it("refuses a manual entry that did NOT ask to override, and says how to", async () => {
    applyVoid();

    const outcome = await recordActualShippingCost({
      orderId: ORDER_ID,
      amountCents: 742,
      source: "manual",
      changedBy: "admin",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/overrideVoidedLabel/);
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
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

// ---------------------------------------------------------------------------
// A STANDING CONDITION IS REPORTED ONCE, NOT EVERY THIRTY MINUTES.
//
// An order whose postage cannot be read back from Shippo stays that way until
// a human enters the figure. recordSystemAlert has no dedup, so this warning
// wrote a system_alerts row on every sweep tick — ~48 a day, indefinitely, for
// a state the sweep itself calls working-as-designed — burying the alerts that
// are real events.
// ---------------------------------------------------------------------------
describe("the manual-entry warning for a permanently unreadable label", () => {
  beforeEach(() => {
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].postage_cost_cents = null;
    db.orders[0].profit_finalized = false;
    shippo.getTransaction.mockResolvedValue({
      ok: true as const,
      data: { object_id: "txn-1", status: "REFUNDED", rate: { amount: "7.42", currency: "USD" } },
    });
  });

  it("is written once, not on every tick", async () => {
    await repairMissingShippingCosts();
    await repairMissingShippingCosts();
    await repairMissingShippingCosts();

    const raised = db.system_alerts.filter((row) => row.type === "shipping_cost_manual_entry_required");
    expect(raised).toHaveLength(1);
  });

  it("is written again when a NEW order joins the backlog", async () => {
    await repairMissingShippingCosts();

    db.orders.push({
      ...db.orders[0],
      order_id: "order-void-2",
      order_number: "VL-VOID002",
      label_purchased_at: "2026-08-23T10:00:00Z",
    });

    await repairMissingShippingCosts();

    const raised = db.system_alerts.filter((row) => row.type === "shipping_cost_manual_entry_required");
    expect(raised).toHaveLength(2);
    expect((raised[1].context as { total: number }).total).toBe(2);
  });

  it("is written again once a human has resolved the previous one", async () => {
    await repairMissingShippingCosts();
    for (const alert of db.system_alerts) alert.resolved_at = "2026-08-24T00:00:00Z";

    await repairMissingShippingCosts();

    expect(db.system_alerts.filter((row) => row.type === "shipping_cost_manual_entry_required")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// THE VOID REFUSAL USED TO FAIL OPEN — FIX WAVE 3.
//
// recordActualShippingCost reads label_voided_at with a narrow SELECT and then
// refuses a voided label. That read discarded its error, and PostgREST resolves
// `{ data: null, error }` rather than throwing for a statement timeout, a
// pooler 503 or a schema-cache miss. `current` was therefore undefined on any
// of them, `current?.label_voided_at` was falsy, and the ONLY money-layer guard
// against re-charging refunded postage was skipped — for an automated
// `source: "shippo"` caller, exactly what the guard's own comment promises is
// impossible. The same undefined also dropped the preserved per-order estimate
// and overwrote it with today's flat config figure.
// ---------------------------------------------------------------------------
describe("recordActualShippingCost when its own void-check read fails", () => {
  const VOID_CHECK_COLUMNS = "estimated_shipping_cost_cents, label_voided_at";
  const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

  beforeEach(() => {
    seedLabelledOrder();
    applyVoid();
    db.failSelect = {};
    // Earlier blocks in this file drive getTransaction to non-SUCCESS states.
    shippo.getTransaction.mockResolvedValue({
      ok: true as const,
      data: { object_id: "txn-1", status: "SUCCESS", rate: { amount: "7.42", currency: "USD" } },
    });
  });

  it("refuses instead of charging the refunded postage to profit", async () => {
    db.failSelect[VOID_CHECK_COLUMNS] = TIMEOUT;

    const outcome = await recordActualShippingCost({
      orderId: ORDER_ID,
      amountCents: 742,
      source: "shippo",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("statement timeout");
    const order = db.orders[0];
    expect(order.actual_shipping_cost_cents).toBeNull();
    expect(order.profit_finalized).toBe(false);
    expect(order.shipping_cost_source).toBeNull();
  });

  it("does not overwrite the preserved estimate with the flat config figure", async () => {
    db.orders[0].estimated_shipping_cost_cents = 1250;
    db.failSelect[VOID_CHECK_COLUMNS] = TIMEOUT;

    await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 742, source: "shippo" });

    // 600 is `shippingCostPerOrder * 100` from the mocked config — the figure
    // the fail-open path used to write over a real historical estimate.
    expect(db.orders[0].estimated_shipping_cost_cents).toBe(1250);
  });

  it("writes no audit row for a refusal", async () => {
    const before = db.order_shipping_cost_audit.length;
    db.failSelect[VOID_CHECK_COLUMNS] = TIMEOUT;

    await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 742, source: "shippo" });

    expect(db.order_shipping_cost_audit).toHaveLength(before);
  });

  it("makes the sweep count it as FAILED, so the critical alert fires", async () => {
    db.failSelect[VOID_CHECK_COLUMNS] = TIMEOUT;
    // A live (non-voided) label, so the sweep genuinely reaches the money write.
    db.orders[0].label_voided_at = null;

    const result = await repairMissingShippingCosts();

    expect(result).toMatchObject({ repaired: 0, failed: 1 });
    const alerted = db.system_alerts.map((row) => row.type);
    expect(alerted).toContain("shipping_cost_unrecorded");
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
  });

  it("still records normally once the read works", async () => {
    db.orders[0].label_voided_at = null;

    const outcome = await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 742, source: "shippo" });

    expect(outcome.ok).toBe(true);
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
  });

  // An UPDATE that matches nothing returns no error. Reporting { ok: true } for
  // it made the sweep count a `repaired` that wrote nothing at all.
  it("does not report success when the update matches no row", async () => {
    db.orders[0].label_voided_at = null;
    const outcome = await recordActualShippingCost({
      orderId: "order-that-does-not-exist",
      amountCents: 742,
      source: "shippo",
    });
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-2 — "ORDER NOT FOUND" WAS STILL WHAT A TRANSIENT PROFIT READ PRODUCED.
//
// recordActualShippingCost was rewritten to tell the two apart ("a throw is an
// unreadable order, null is a missing one"), but getOrderProfit destructured
// only `{ data: order }` and dropped the error — so the throw could never
// happen and the operator was told the wrong cause for the single most likely
// read to fail, on a row that plainly exists.
// ---------------------------------------------------------------------------
describe("recordActualShippingCost when the PROFIT read fails", () => {
  // THE REAL SELECT LIST, NOT A COPY OF IT. This was a hand-written duplicate
  // that had to be edited every time the profit read gained a column — and a
  // duplicate that drifts is precisely how a stale fixture hides a defect.
  const PROFIT_COLUMNS = ORDER_FIELDS;
  const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

  beforeEach(() => {
    seedLabelledOrder();
    // The sweep's own shape: a bought label with no cost recorded yet.
    db.orders[0].actual_shipping_cost_cents = null;
    db.orders[0].shipping_cost_source = null;
    db.failSelect = {};
    shippo.getTransaction.mockResolvedValue({
      ok: true as const,
      data: { object_id: "txn-1", status: "SUCCESS", rate: { amount: "7.42", currency: "USD" } },
    });
  });

  it("names the read failure, not a missing order", async () => {
    db.failSelect[PROFIT_COLUMNS] = TIMEOUT;

    const outcome = await recordActualShippingCost({ orderId: ORDER_ID, amountCents: 742, source: "shippo" });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("statement timeout");
    expect(outcome.error).not.toContain("Order not found");
    expect(db.orders[0].actual_shipping_cost_cents).toBeNull();
  });

  it("makes the sweep count it as FAILED with the true cause", async () => {
    db.failSelect[PROFIT_COLUMNS] = TIMEOUT;

    const result = await repairMissingShippingCosts();

    expect(result).toMatchObject({ repaired: 0, failed: 1 });
    const alert = db.system_alerts.find((row) => row.type === "shipping_cost_unrecorded");
    const failures = (alert!.context as { failures: Array<{ error: string }> }).failures;
    expect(failures[0].error).toContain("statement timeout");
  });

  it("still says 'Order not found' for an order that genuinely is not there", async () => {
    const outcome = await recordActualShippingCost({
      orderId: "order-that-does-not-exist",
      amountCents: 742,
      source: "shippo",
    });

    expect(outcome).toMatchObject({ ok: false, error: "Order not found" });
  });
});
