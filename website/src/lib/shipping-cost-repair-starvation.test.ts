import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// STREAMING ARRIVALS, NOT A STATIC PILE.
//
// Three separate reviews certified this sweep against a fixed set of orders and
// all three missed the same defect, because the defect only exists while orders
// keep arriving. A live store buys labels continuously, so every case below
// pushes NEW candidates between ticks and asserts on rows that were already
// waiting before those arrivals started.
//
// The regression under test: the previous two-ended scan reserved half the
// per-run budget for the NEWEST candidates. At an arrival rate at or above that
// half (25/tick), the newest slice was permanently consumed by brand-new rows,
// the oldest slice by rows that can never be repaired, and everything between
// them was never looked at again — measured at 40/40 middle orders unrepaired
// after 12 ticks, against 2 ticks to drain for the oldest-first code it
// replaced.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: { orders: Row[]; system_alerts: Row[] } = { orders: [], system_alerts: [] };

const mocks = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  settledCentsFromTransaction: vi.fn(),
  settledCentsForTransaction: vi.fn(),
  recordActualShippingCost: vi.fn(),
  recordSystemAlert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/shippo/client", () => ({
  getTransaction: mocks.getTransaction,
  settledCentsFromTransaction: mocks.settledCentsFromTransaction,
  settledCentsForTransaction: mocks.settledCentsForTransaction,
}));
vi.mock("@/lib/admin-profit", () => ({ recordActualShippingCost: mocks.recordActualShippingCost }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: mocks.recordSystemAlert }));

// A PostgREST-shaped double over two real tables. It honours the filters, the
// multi-key ordering and .range() paging the sweep actually issues, so paging
// bugs and tie-break bugs show up here rather than in production.
vi.mock("@/lib/supabase-server", () => {
  function builder(name: string) {
    const rows = (db as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(rows)) throw new Error(`unexpected table: ${name}`);
    const filters: Array<(row: Row) => boolean> = [];
    const sortKeys: Array<{ col: string; asc: boolean }> = [];
    function settle(from: number | null, to: number | null, take: number | null) {
      let out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      out.sort((a, b) => {
        for (const { col, asc } of sortKeys) {
          const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
          if (cmp !== 0) return asc ? cmp : -cmp;
        }
        return 0;
      });
      if (from != null && to != null) out = out.slice(from, to + 1);
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error("unsupported not");
        filters.push((r) => (r[c] ?? null) !== null);
        return b;
      },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      order(c: string, o?: { ascending?: boolean }) { sortKeys.push({ col: c, asc: o?.ascending !== false }); return b; },
      range(from: number, to: number) { return Promise.resolve(settle(from, to, null)); },
      limit(n: number) { return Promise.resolve(settle(null, null, n)); },
    };
    return b;
  }
  return { supabaseAdmin: { from: (n: string) => builder(n) } };
});

const { repairMissingShippingCosts, selectProbeOrder } = await import("@/lib/shipping-cost-repair");

const NOW = new Date("2026-08-27T00:00:00Z");
// Minute-resolution timestamps inside the 90-day window, so ordering is total
// and deterministic and paging boundaries are reproducible.
const at = (mins: number) => new Date(Date.UTC(2026, 6, 1) + mins * 60_000).toISOString();

function candidate(id: string, ts: string, txn = `txn-live-${id}`): Row {
  return {
    order_id: id,
    label_purchased_at: ts,
    label_voided_at: null,
    shippo_transaction_id: txn,
    actual_shipping_cost_cents: null,
    postage_cost_cents: null,
  };
}

let alertClock = 0;
/** How many Shippo GETs each order has cost across the whole scenario. */
let probes: Map<string, number>;
/** Transaction ids whose lookup should fail with a transient error. */
let transientlyBroken: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  db.orders = [];
  db.system_alerts = [];
  alertClock = 0;
  probes = new Map();
  transientlyBroken = new Set();

  mocks.recordSystemAlert.mockImplementation(async (alert: Row) => {
    db.system_alerts.push({ ...alert, created_at: `2026-08-27T00:00:${String(alertClock++).padStart(6, "0")}Z`, resolved_at: null });
  });
  mocks.settledCentsFromTransaction.mockImplementation((rate: unknown) =>
    rate && typeof rate === "object" ? 742 : null);
  // An expanded rate carries its price. A bare reference is resolved with a
  // rate lookup — and the unrepairable class here is the one where THAT cannot
  // be priced either, which is what leaves the sweep with nothing to record.
  mocks.settledCentsForTransaction.mockImplementation(async (txn: { rate?: unknown }) =>
    txn?.rate && typeof txn.rate === "object" ? 742 : null);
  mocks.getTransaction.mockImplementation(async (txnId: string) => {
    probes.set(String(txnId), (probes.get(String(txnId)) ?? 0) + 1);
    if (transientlyBroken.has(String(txnId))) return { ok: false as const, message: "Shippo timed out" };
    // A dashboard-adopted label whose rate is a bare id reference can NEVER be
    // read back: this is the permanently-unrepairable class.
    if (String(txnId).startsWith("txn-stuck")) {
      return { ok: true as const, data: { status: "SUCCESS", rate: "bare-rate-id" } };
    }
    return { ok: true as const, data: { status: "SUCCESS", rate: { amount: "7.42" } } };
  });
  mocks.recordActualShippingCost.mockImplementation(async (input: { orderId: string; amountCents: number }) => {
    const row = db.orders.find((o) => o.order_id === input.orderId);
    if (!row) return { ok: false as const, error: "Order not found" };
    if (row.actual_shipping_cost_cents != null) {
      throw new Error(`DOUBLE WRITE on ${input.orderId}`);
    }
    row.actual_shipping_cost_cents = input.amountCents;
    return { ok: true as const };
  });
});

const unrepairedMiddle = () =>
  db.orders.filter((o) => String(o.order_id).startsWith("mid-") && o.actual_shipping_cost_cents == null).length;

describe("selectProbeOrder — the budget rule, in isolation", () => {
  const rows = (...ids: string[]) => ids.map((order_id) => ({ order_id }));

  it("spends the budget on rows with no recorded probe outcome first", () => {
    const picked = selectProbeOrder(rows("a", "b", "c", "d"), new Set(["a", "b"]), 2);
    expect(picked.map((r) => r.order_id)).toEqual(["c", "d"]);
  });

  it("gives known-failing rows the budget the fresh tier did not use", () => {
    const picked = selectProbeOrder(rows("a", "b", "c", "d"), new Set(["a", "b"]), 3);
    expect(picked.map((r) => r.order_id)).toEqual(["c", "d", "a"]);
  });

  it("never excludes a known-failing row permanently — with spare budget it is retried", () => {
    const picked = selectProbeOrder(rows("a", "b"), new Set(["a", "b"]), 5);
    expect(picked.map((r) => r.order_id)).toEqual(["a", "b"]);
  });

  // The retry tier is where the same starvation shape could grow back: more
  // known-failing rows than spare budget, always taken from the head, means the
  // rows behind them are never tried again.
  it("rotates the retry tier so every known-failing row is reachable", () => {
    const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const deferred = new Set(all);
    const seen = new Set<string>();
    const trace: string[] = [];
    // Budget 8, no fresh rows, so the retry slice is ceil(8/4) = 2 per tick and
    // the start advances by the slice: four ticks cover all eight.
    for (let tick = 0; tick < 4; tick++) {
      const picked = selectProbeOrder(rows(...all), deferred, 8, tick);
      trace.push(`tick ${tick}: ${picked.map((r) => r.order_id).join(",")}`);
      for (const row of picked) seen.add(row.order_id);
    }
    console.log("\n=== retry rotation, 8 stuck rows, slice 2 ===\n" + trace.join("\n"));
    expect([...seen].sort()).toEqual(all);
  });

  // A retry is a Shippo call spent on a row that probably will not settle. A
  // large permanently-stuck backlog must not burn the whole budget on it every
  // thirty minutes for ever.
  it("spends at most a quarter of the budget on known-failing rows", () => {
    const all = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const picked = selectProbeOrder(rows(...all), new Set(all), 50, 3);
    expect(picked).toHaveLength(13);
  });

  it("still gives the fresh tier the whole budget before rotating anything", () => {
    const picked = selectProbeOrder(rows("a", "b", "c", "d"), new Set(["a", "b"]), 2, 7);
    expect(picked.map((r) => r.order_id)).toEqual(["c", "d"]);
  });
});

describe("repairMissingShippingCosts — streaming arrivals (F-4 regression)", () => {
  it("drains the middle of the window while 25 new labels arrive every tick", async () => {
    // 25 permanently-unrepairable rows holding the OLDEST end.
    for (let i = 0; i < 25; i++) {
      db.orders.push(candidate(`stuck-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-${i}`));
    }
    // 40 perfectly repairable rows in the MIDDLE — the rows the two-ended scan
    // could never reach.
    for (let i = 0; i < 40; i++) {
      db.orders.push(candidate(`mid-${String(i).padStart(3, "0")}`, at(1000 + i)));
    }

    let clock = 5000;
    const log: string[] = [];
    let drainedAtTick = -1;
    for (let tick = 0; tick < 12; tick++) {
      // A busy half hour: 25 brand-new repairable orders between ticks. This is
      // exactly the arrival rate at which the previous design starved.
      for (let i = 0; i < 25; i++) {
        db.orders.push(candidate(`new-${tick}-${String(i).padStart(3, "0")}`, at(clock++)));
      }
      const r = await repairMissingShippingCosts({ now: NOW });
      const left = unrepairedMiddle();
      if (left === 0 && drainedAtTick < 0) drainedAtTick = tick;
      log.push(
        `tick ${tick}: scanned=${r.scanned} repaired=${r.repaired} failed=${r.failed} `
        + `middleUnrepaired=${left}/40 alertRows=${db.system_alerts.length}`,
      );
    }
    console.log("\n=== 25 stuck oldest + 40 repairable middle + 25 arrivals/tick ===\n" + log.join("\n"));
    console.log(`middle fully repaired at tick ${drainedAtTick}`);

    expect(unrepairedMiddle()).toBe(0);
    // 40 middle rows behind 25 stuck ones, budget 50: two ticks is the bound.
    expect(drainedAtTick).toBeLessThanOrEqual(2);
  });

  // THE v1 STARVATION CLASS, which the two-ended scan existed to fix: enough
  // permanently-unrepairable rows at the OLDEST end to consume the whole
  // per-run budget. Plain oldest-first never gets past them.
  it("drains rows sitting behind a full budget's worth of unrepairable ones", async () => {
    for (let i = 0; i < 55; i++) {
      db.orders.push(candidate(`stuck-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-${i}`));
    }
    for (let i = 0; i < 40; i++) {
      db.orders.push(candidate(`mid-${String(i).padStart(3, "0")}`, at(1000 + i)));
    }

    let clock = 5000;
    const log: string[] = [];
    for (let tick = 0; tick < 6; tick++) {
      for (let i = 0; i < 25; i++) {
        db.orders.push(candidate(`new-${tick}-${String(i).padStart(3, "0")}`, at(clock++)));
      }
      const r = await repairMissingShippingCosts({ now: new Date(NOW.getTime() + tick * 30 * 60_000) });
      log.push(`tick ${tick}: scanned=${r.scanned} repaired=${r.repaired} failed=${r.failed} middleUnrepaired=${unrepairedMiddle()}/40`);
    }
    console.log("\n=== 55 stuck oldest (> budget) + 40 middle + 25 arrivals/tick ===\n" + log.join("\n"));
    expect(unrepairedMiddle()).toBe(0);
  });

  it("keeps arrival RATE out of the reach bound — 0, 10, 25, 60 and 200 per tick all drain", async () => {
    const summary: string[] = [];
    for (const rate of [0, 10, 25, 60, 200]) {
      db.orders = [];
      db.system_alerts = [];
      alertClock = 0;
      for (let i = 0; i < 25; i++) {
        db.orders.push(candidate(`stuck-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-${i}`));
      }
      for (let i = 0; i < 40; i++) {
        db.orders.push(candidate(`mid-${String(i).padStart(3, "0")}`, at(1000 + i)));
      }
      let clock = 5000;
      let drained = -1;
      for (let tick = 0; tick < 10 && drained < 0; tick++) {
        for (let i = 0; i < rate; i++) {
          db.orders.push(candidate(`new-${tick}-${String(i).padStart(4, "0")}`, at(clock++)));
        }
        await repairMissingShippingCosts({ now: NOW });
        if (unrepairedMiddle() === 0) drained = tick;
      }
      summary.push(`arrivals/tick=${String(rate).padStart(3)} -> middle drained at tick ${drained}`);
      expect(drained).toBeGreaterThanOrEqual(0);
      expect(drained).toBeLessThanOrEqual(2);
    }
    console.log("\n=== arrival-rate sweep ===\n" + summary.join("\n"));
  });

  it("reaches the middle when BOTH ends are held by unrepairable rows", async () => {
    for (let i = 0; i < 25; i++) {
      db.orders.push(candidate(`stuck-old-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-o${i}`));
    }
    for (let i = 0; i < 40; i++) {
      db.orders.push(candidate(`mid-${String(i).padStart(3, "0")}`, at(1000 + i)));
    }
    for (let i = 0; i < 25; i++) {
      db.orders.push(candidate(`stuck-new-${String(i).padStart(3, "0")}`, at(9000 + i), `txn-stuck-n${i}`));
    }

    const log: string[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const r = await repairMissingShippingCosts({ now: NOW });
      log.push(`tick ${tick}: scanned=${r.scanned} repaired=${r.repaired} failed=${r.failed} middleUnrepaired=${unrepairedMiddle()}/40`);
    }
    console.log("\n=== 25 stuck at each end, no arrivals ===\n" + log.join("\n"));
    expect(unrepairedMiddle()).toBe(0);
  });

  it("stops spending the Shippo budget on rows that can never settle", async () => {
    for (let i = 0; i < 60; i++) {
      db.orders.push(candidate(`stuck-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-${i}`));
    }
    // Tick 0 classifies as many as the budget allows; from then on they are
    // deprioritised, so a repairable row arriving later is not held up.
    await repairMissingShippingCosts({ now: NOW });
    await repairMissingShippingCosts({ now: NOW });
    db.orders.push(candidate("late-repairable", at(9999)));
    const probesBefore = [...probes.values()].reduce((a, b) => a + b, 0);
    const third = await repairMissingShippingCosts({ now: NOW });
    console.log(`\n=== 60 permanently-stuck rows, budget 50 ===\ntick 2: ${JSON.stringify(third)}`);

    const row = db.orders.find((o) => o.order_id === "late-repairable");
    expect(row?.actual_shipping_cost_cents).toBe(742);
    // The stuck rows still get the LEFTOVER budget (they are never excluded
    // permanently), but they no longer come first.
    expect([...probes.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(probesBefore);
  });

  it("retries a transient lookup failure instead of writing it off", async () => {
    db.orders.push(candidate("flaky", at(1)));
    transientlyBroken.add("txn-live-flaky");
    const first = await repairMissingShippingCosts({ now: NOW });
    expect(first).toMatchObject({ repaired: 0, failed: 1 });

    transientlyBroken.clear();
    const second = await repairMissingShippingCosts({ now: NOW });
    console.log(`\n=== transient failure ===\ntick 0: ${JSON.stringify(first)}\ntick 1: ${JSON.stringify(second)}`);
    expect(second).toMatchObject({ repaired: 1, failed: 0 });
    expect(db.orders[0].actual_shipping_cost_cents).toBe(742);
  });

  it("names the unrepairable backlog and does not storm about it", async () => {
    for (let i = 0; i < 30; i++) {
      db.orders.push(candidate(`stuck-${String(i).padStart(3, "0")}`, at(i), `txn-stuck-${i}`));
    }
    let clock = 5000;
    for (let tick = 0; tick < 8; tick++) {
      // Repairable orders keep arriving; the backlog itself does not change.
      for (let i = 0; i < 5; i++) {
        db.orders.push(candidate(`new-${tick}-${i}`, at(clock++)));
      }
      await repairMissingShippingCosts({ now: NOW });
    }
    const manualAlerts = db.system_alerts.filter((a) => a.type === "shipping_cost_manual_entry_required");
    console.log(`\n=== manual-entry backlog over 8 ticks ===\nalert rows written: ${manualAlerts.length}`);
    expect(manualAlerts).toHaveLength(1);
    // The reported backlog names EVERY stuck order, not just the capped detail
    // list — the old shape reported `total` from the truncated 25-row slice.
    const context = manualAlerts[0].context as { orderIds: string[]; total: number };
    expect(context.total).toBe(30);
    expect(context.orderIds).toHaveLength(30);
    // Every repairable arrival was still repaired.
    expect(db.orders.filter((o) => String(o.order_id).startsWith("new-") && o.actual_shipping_cost_cents == null)).toHaveLength(0);
  });

  it("drops an order from the backlog once a human enters its cost by hand", async () => {
    for (let i = 0; i < 3; i++) {
      db.orders.push(candidate(`stuck-${i}`, at(i), `txn-stuck-${i}`));
    }
    await repairMissingShippingCosts({ now: NOW });
    // The operator types the figure in for one of them.
    db.orders.find((o) => o.order_id === "stuck-1")!.actual_shipping_cost_cents = 500;
    await repairMissingShippingCosts({ now: NOW });

    const latest = db.system_alerts.filter((a) => a.type === "shipping_cost_manual_entry_required").at(-1);
    const context = latest!.context as { orderIds: string[]; total: number };
    console.log(`\n=== backlog after a hand entry ===\n${JSON.stringify(context.orderIds)}`);
    expect(context.orderIds.sort()).toEqual(["stuck-0", "stuck-2"]);
    expect(context.total).toBe(2);
  });

  // A LARGE unrepairable backlog must SETTLE, not churn. Each tick classifies
  // another budget's worth, so the backlog genuinely changes while it is being
  // discovered and an alert per change is honest — but once every row is on
  // file it must go quiet, and no row may be dropped from the stored list only
  // to be re-probed and re-added for ever.
  it("settles on a large unrepairable backlog instead of storming", async () => {
    for (let i = 0; i < 600; i++) {
      db.orders.push(candidate(`stuck-${String(i).padStart(4, "0")}`, at(i), `txn-stuck-${i}`));
    }
    const perTick: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const before = db.system_alerts.length;
      await repairMissingShippingCosts({ now: new Date(NOW.getTime() + tick * 30 * 60_000) });
      perTick.push(db.system_alerts.length - before);
    }
    console.log(`\n=== 600 unrepairable rows, 20 ticks ===\nalert rows per tick: ${perTick.join(",")}`);
    // Discovered at `limit` per tick: 12 ticks to learn all 600, then silence.
    expect(perTick.slice(13).every((count) => count === 0)).toBe(true);
    const manualAlerts = db.system_alerts.filter((a) => a.type === "shipping_cost_manual_entry_required");
    const stored = manualAlerts.at(-1)!.context as { orderIds: string[]; total: number };
    expect(stored.orderIds).toHaveLength(600);
    expect(stored.total).toBe(600);
  });

  it("never records a cost twice for the same order across many ticks", async () => {
    for (let i = 0; i < 120; i++) db.orders.push(candidate(`o-${String(i).padStart(3, "0")}`, at(i)));
    let clock = 5000;
    let repairedTotal = 0;
    for (let tick = 0; tick < 6; tick++) {
      for (let i = 0; i < 30; i++) db.orders.push(candidate(`n-${tick}-${i}`, at(clock++)));
      // recordActualShippingCost THROWS on a second write, so a double-write
      // would surface as a failed count here.
      const r = await repairMissingShippingCosts({ now: NOW });
      repairedTotal += r.repaired;
      expect(r.failed).toBe(0);
    }
    const done = db.orders.filter((o) => o.actual_shipping_cost_cents != null).length;
    console.log(`\n=== no double-write over 6 ticks ===\nrepaired reported=${repairedTotal} rows actually costed=${done} total rows=${db.orders.length}`);
    expect(repairedTotal).toBe(done);
    expect(db.orders.filter((o) => o.actual_shipping_cost_cents == null)).toHaveLength(0);
  });
});
