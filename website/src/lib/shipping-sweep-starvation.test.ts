import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// `limit` MUST BOUND THE SHIPPO CALLS, NOT WHICH ROWS ARE VISIBLE.
//
// Two starvation classes lived in this sweep, and the first was completely
// silent:
//
//   CLASS A  `shippo_transaction_id IS NOT NULL` was enforced only in the
//            JavaScript predicate, never in the query. `limit` therefore
//            bounded the rows SCANNED, not the candidates: fifty rows with a
//            label_purchased_at and no transaction id — which a thin
//            transaction_created delivery produces — filled the page forever.
//            The run reported {scanned:50, repaired:0, failed:0}, which is
//            indistinguishable from "nothing to do", with NO alert at all.
//
//   CLASS B  fifty labels whose Shippo lookup can never settle (status not
//            SUCCESS, or a bare rate reference) held every slot forever too.
//            The docstring documented the ALERT STORM from these rows as fixed;
//            it did not acknowledge that they also stop the sweep advancing.
//
// The FIRST attempt at class B split the budget oldest-half / newest-half. That
// moved the starvation into the MIDDLE of the window: see
// shipping-cost-repair-starvation.test.ts, which streams arrivals and is the
// test that would have caught it. The design now pages the (cheap) candidate
// SELECT across the whole window and spends the Shippo budget on rows with no
// recorded probe outcome first, leaving known-unrepairable ones the leftovers.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: { orders: Row[]; system_alerts: Row[] } = { orders: [], system_alerts: [] };

const shippo = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  settledCentsFromTransaction: vi.fn((rate: unknown) =>
    rate && typeof rate === "object" ? 742 : null,
  ),
  recordActualShippingCost: vi.fn(),
  recordSystemAlert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/shippo/client", () => ({
  getTransaction: shippo.getTransaction,
  settledCentsFromTransaction: shippo.settledCentsFromTransaction,
}));
vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost: shippo.recordActualShippingCost }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: shippo.recordSystemAlert }));

vi.mock("@/lib/supabase-server", () => {
  function builder(name: string) {
    const rows = (db as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(rows)) throw new Error(`unexpected table in test: ${name}`);

    const filters: Array<(row: Row) => boolean> = [];
    const sortKeys: Array<{ col: string; asc: boolean }> = [];
    let take: number | null = null;
    let skip = 0;

    function settle() {
      let out = rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row }));
      // Multi-key ordering: without a tiebreak, rows sharing a
      // label_purchased_at have no defined order and the two ends of the scan
      // can return the same ones.
      if (sortKeys.length > 0) {
        out.sort((a, b) => {
          for (const { col, asc } of sortKeys) {
            const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
            if (cmp !== 0) return asc ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (skip > 0) out = out.slice(skip);
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      not(col: string, op: string, value: unknown) {
        if (op !== "is" || value !== null) throw new Error(`unsupported .not(${op})`);
        filters.push((row) => (row[col] ?? null) !== null);
        return b;
      },
      gte(col: string, value: unknown) { filters.push((row) => String(row[col] ?? "") >= String(value)); return b; },
      order(col: string, opts?: { ascending?: boolean }) { sortKeys.push({ col, asc: opts?.ascending !== false }); return b; },
      limit(n: number) { take = n; return b; },
      // Offset paging, as PostgREST implements .range(): inclusive both ends.
      range(from: number, to: number) { skip = from; take = to - from + 1; return b; },
      insert(next: Row | Row[]) {
        for (const row of Array.isArray(next) ? next : [next]) rows.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }
  return { supabaseAdmin: { from: (name: string) => builder(name) } };
});

const { repairMissingShippingCosts } = await import("@/lib/shipping-cost-repair");

/** Day D of August 2026, as a label_purchased_at. Older = smaller D. */
const day = (index: number) => `2026-08-${String(index).padStart(2, "0")}T10:00:00Z`;

function candidate(overrides: Row = {}): Row {
  return {
    order_id: `order-${Math.random().toString(36).slice(2, 10)}`,
    label_purchased_at: day(1),
    label_voided_at: null,
    shippo_transaction_id: "txn-live",
    actual_shipping_cost_cents: null,
    postage_cost_cents: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orders = [];
  db.system_alerts = [];
  shippo.recordSystemAlert.mockImplementation(async (alert: Row) => {
    db.system_alerts.push({
      ...alert,
      resolved_at: null,
      created_at: new Date(Date.now() + db.system_alerts.length).toISOString(),
    });
  });
  // Live label, settled rate.
  shippo.getTransaction.mockResolvedValue({
    ok: true as const,
    data: { status: "SUCCESS", rate: { amount: "7.42" } },
  });
  shippo.recordActualShippingCost.mockImplementation(async (input: { orderId: string; amountCents: number }) => {
    const row = db.orders.find((order) => order.order_id === input.orderId);
    if (row) row.actual_shipping_cost_cents = input.amountCents;
    return { ok: true as const };
  });
});

describe("class A — rows with no Shippo transaction at all", () => {
  it("are never scanned, so they cannot hold a slot", async () => {
    db.orders = [
      ...Array.from({ length: 50 }, (_, i) =>
        candidate({ order_id: `no-txn-${i}`, label_purchased_at: day(1), shippo_transaction_id: null })),
      candidate({ order_id: "victim", label_purchased_at: day(20) }),
    ];

    const result = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    expect(result.scanned).toBe(1);
    expect(result.repaired).toBe(1);
    expect(db.orders.find((o) => o.order_id === "victim")!.actual_shipping_cost_cents).toBe(742);
  });

  it("cost no Shippo lookups either", async () => {
    db.orders = Array.from({ length: 50 }, (_, i) =>
      candidate({ order_id: `no-txn-${i}`, shippo_transaction_id: null }));

    await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    expect(shippo.getTransaction).not.toHaveBeenCalled();
  });
});

describe("class B — labels whose lookup can never settle", () => {
  /** A dashboard label with a bare rate reference: no postage is readable. */
  function stuck(orderId: string, purchasedAt: string) {
    return candidate({ order_id: orderId, label_purchased_at: purchasedAt, shippo_transaction_id: `txn-${orderId}` });
  }

  beforeEach(() => {
    shippo.getTransaction.mockImplementation(async (transactionId: string) =>
      String(transactionId).startsWith("txn-stuck")
        ? { ok: true as const, data: { status: "SUCCESS", rate: "bare-rate-id" } }
        : { ok: true as const, data: { status: "SUCCESS", rate: { amount: "7.42" } } },
    );
  });

  it("no longer starve a newer repairable order", async () => {
    db.orders = [
      ...Array.from({ length: 50 }, (_, i) => stuck(`stuck-${i}`, day(1))),
      candidate({ order_id: "victim", label_purchased_at: day(20) }),
    ];

    // ONE TICK OF LAG, NOT FOREVER — and that lag is the point. Reserving a
    // slice of every run for the newest end is what starved the middle of the
    // window (F-4). Instead, the first run learns that the fifty are
    // unrepairable and the second spends its budget on everything else. The
    // finding was `repaired: 0` on EVERY tick, for ever.
    const first = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });
    expect(first.failed).toBe(50);
    const second = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:30:00Z") });

    expect(second.repaired).toBe(1);
    expect(db.orders.find((o) => o.order_id === "victim")!.actual_shipping_cost_cents).toBe(742);
  });

  it("drain the newer end tick after tick while the stuck core stays put", async () => {
    db.orders = [
      ...Array.from({ length: 50 }, (_, i) => stuck(`stuck-${i}`, day(1))),
      ...Array.from({ length: 60 }, (_, i) => candidate({ order_id: `newer-${i}`, label_purchased_at: day(10 + (i % 15)) })),
    ];

    let repaired = 0;
    for (let tick = 0; tick < 4; tick++) {
      repaired += (await repairMissingShippingCosts({
        now: new Date(Date.UTC(2026, 7, 27, 0, tick * 30),
        ),
      })).repaired;
    }

    expect(repaired).toBe(60);
    expect(db.orders.filter((o) => String(o.order_id).startsWith("newer-") && o.actual_shipping_cost_cents == null))
      .toHaveLength(0);
  });

  it("say so CRITICALLY once they consume the whole per-run budget", async () => {
    db.orders = Array.from({ length: 50 }, (_, i) => stuck(`stuck-${i}`, day(1)));

    await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    const alert = db.system_alerts.find((row) => row.type === "shipping_cost_manual_entry_required");
    expect(alert).toBeDefined();
    // A `warning` with no email was the only signal that the sweep had stopped.
    expect(alert!.severity).toBe("critical");
    // The reported backlog is now the WHOLE set, not the capped detail list —
    // `total` used to be read off a 25-row slice and understated it.
    expect((alert!.context as { total: number }).total).toBe(50);
  });

  it("stay a warning while the backlog is small enough to work around", async () => {
    db.orders = [stuck("stuck-0", day(1)), candidate({ order_id: "fine", label_purchased_at: day(2) })];

    await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    const alert = db.system_alerts.find((row) => row.type === "shipping_cost_manual_entry_required");
    expect(alert!.severity).toBe("warning");
  });

  it("tell the operator NOT to hand-enter a cost for a refunded label", async () => {
    shippo.getTransaction.mockResolvedValue({ ok: true as const, data: { status: "REFUNDED", rate: { amount: "7.42" } } });
    db.orders = [candidate({ order_id: "voided-at-shippo" })];

    await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    const alert = db.system_alerts.find((row) => row.type === "shipping_cost_manual_entry_required");
    const orders = (alert!.context as { orders: Array<{ error: string }> }).orders;
    // label_voided_at is NULL locally for a dashboard void, so the admin screen
    // will ACCEPT a hand-entered figure with no override — charging profit for
    // postage the carrier gave back.
    expect(orders[0].error).toContain("VOIDED");
    expect(orders[0].error).toContain("overrideVoidedLabel");
  });
});

describe("ordinary backlogs still converge", () => {
  it("clears 120 repairable orders and then writes nothing", async () => {
    db.orders = Array.from({ length: 120 }, (_, i) =>
      candidate({ order_id: `bulk-${i}`, label_purchased_at: day(1 + (i % 20)) }));

    let ticks = 0;
    let result = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });
    while (result.repaired > 0 && ticks < 10) {
      ticks += 1;
      result = await repairMissingShippingCosts({ now: new Date(Date.UTC(2026, 7, 27, 0, ticks * 30)) });
    }

    expect(db.orders.filter((o) => o.actual_shipping_cost_cents == null)).toHaveLength(0);
    expect(result).toEqual({ scanned: 0, repaired: 0, failed: 0 });
    expect(db.system_alerts).toHaveLength(0);
  });

  it("does not re-read an order whose cost is already recorded", async () => {
    db.orders = [candidate({ order_id: "done", actual_shipping_cost_cents: 742 })];

    const result = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    expect(result.scanned).toBe(0);
    expect(shippo.getTransaction).not.toHaveBeenCalled();
  });

  it("never scans a voided label", async () => {
    db.orders = [candidate({ order_id: "voided", label_voided_at: "2026-08-22T00:00:00Z" })];

    const result = await repairMissingShippingCosts({ now: new Date("2026-08-27T00:00:00Z") });

    expect(result.scanned).toBe(0);
    expect(shippo.recordActualShippingCost).not.toHaveBeenCalled();
  });
});
