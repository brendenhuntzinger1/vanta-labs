import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OMNISEND_BACKSTOP_BUDGET_MS,
  OMNISEND_BACKSTOP_FLOOR_GRACE_MS,
  OMNISEND_BACKSTOP_LOOKBACK_MS,
  OMNISEND_STALE_CLAIM_MS,
  backstopBudgetAllows,
  backstopFloorDecision,
  backstopRunNotes,
  cadenceDecision,
  ordersNeedingOmnisendPaid,
  staleOmnisendClaims,
} from "@/lib/marketing/omnisend/sweeps";

/**
 * The decisions the Omnisend sweeps make, tested without a database:
 *
 *   * which paid orders still owe Omnisend a `paid for order` (the backstop
 *     for a webhook after() callback that died with the function);
 *   * which undelivered ledger claims are old enough to be dead and can be
 *     handed back so the backstop can retry them;
 *   * whether a cadence-limited job is due, and how it says why not.
 */

const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function order(overrides: Partial<Parameters<typeof ordersNeedingOmnisendPaid>[0][number]> = {}) {
  return {
    order_id: "order-1",
    payment_status: "paid",
    order_type: "product",
    replacement_of: null,
    paid_at: new Date(NOW.getTime() - HOUR).toISOString(),
    created_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    ...overrides,
  };
}

describe("ordersNeedingOmnisendPaid", () => {
  it("keeps a paid product order from the last seven days with no delivered `paid for order` row", () => {
    expect(ordersNeedingOmnisendPaid([order()], [], NOW)).toHaveLength(1);
  });

  it("accepts every paid status the ledger accepts, case-insensitively", () => {
    for (const status of ["paid", "completed", "succeeded", "PAID"]) {
      expect(ordersNeedingOmnisendPaid([order({ payment_status: status })], [], NOW), status).toHaveLength(1);
    }
    for (const status of ["pending_payment", "payment_failed", "canceled", "refunded", "partially_refunded", "", null]) {
      expect(ordersNeedingOmnisendPaid([order({ payment_status: status })], [], NOW), String(status)).toHaveLength(0);
    }
  });

  it("skips a membership charge and a replacement reship — neither is a purchase", () => {
    expect(ordersNeedingOmnisendPaid([order({ order_type: "membership" })], [], NOW)).toHaveLength(0);
    expect(ordersNeedingOmnisendPaid([order({ order_type: "replacement" })], [], NOW)).toHaveLength(0);
    expect(ordersNeedingOmnisendPaid([order({ replacement_of: "order-0" })], [], NOW)).toHaveLength(0);
    // A row without the column is a product order, as everywhere else.
    expect(ordersNeedingOmnisendPaid([order({ order_type: null })], [], NOW)).toHaveLength(1);
  });

  it("skips an order already delivered, but not one whose row is undelivered", () => {
    const delivered = { entity_id: "order-1", event_name: "paid for order", delivered: true, first_sent_at: NOW.toISOString() };
    expect(ordersNeedingOmnisendPaid([order()], [delivered], NOW)).toHaveLength(0);
    const refused = { ...delivered, delivered: false };
    expect(ordersNeedingOmnisendPaid([order()], [refused], NOW)).toHaveLength(1);
  });

  it("only a delivered `paid for order` counts — a delivered `placed order` alone does not", () => {
    const placed = { entity_id: "order-1", event_name: "placed order", delivered: true, first_sent_at: NOW.toISOString() };
    expect(ordersNeedingOmnisendPaid([order()], [placed], NOW)).toHaveLength(1);
    const other = { entity_id: "order-2", event_name: "paid for order", delivered: true, first_sent_at: NOW.toISOString() };
    expect(ordersNeedingOmnisendPaid([order()], [other], NOW)).toHaveLength(1);
  });

  it("bounds the window to seven days on paid_at, falling back to created_at", () => {
    expect(OMNISEND_BACKSTOP_LOOKBACK_MS).toBe(7 * DAY);
    const old = order({ paid_at: new Date(NOW.getTime() - 8 * DAY).toISOString() });
    expect(ordersNeedingOmnisendPaid([old], [], NOW)).toHaveLength(0);
    const edge = order({ paid_at: new Date(NOW.getTime() - 7 * DAY).toISOString() });
    expect(ordersNeedingOmnisendPaid([edge], [], NOW)).toHaveLength(1);
    const noPaidAt = order({ paid_at: null, created_at: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    expect(ordersNeedingOmnisendPaid([noPaidAt], [], NOW)).toHaveLength(1);
    const noDates = order({ paid_at: null, created_at: null });
    expect(ordersNeedingOmnisendPaid([noDates], [], NOW)).toHaveLength(0);
    const garbage = order({ paid_at: "not a date", created_at: "also not" });
    expect(ordersNeedingOmnisendPaid([garbage], [], NOW)).toHaveLength(0);
  });

  it("returns the orders in the order given, without duplicates", () => {
    const rows = [order({ order_id: "a" }), order({ order_id: "b" }), order({ order_id: "a" })];
    expect(ordersNeedingOmnisendPaid(rows, [], NOW).map((row) => row.order_id)).toEqual(["a", "b"]);
  });
});

describe("staleOmnisendClaims", () => {
  const fresh = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const stale = new Date(NOW.getTime() - OMNISEND_STALE_CLAIM_MS - 1000).toISOString();

  it("is a long way past anything an after() callback can still be doing", () => {
    expect(OMNISEND_STALE_CLAIM_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it("names only undelivered claims older than the threshold", () => {
    const rows = [
      { entity_id: "a", event_name: "paid for order", delivered: false, first_sent_at: stale },
      { entity_id: "b", event_name: "paid for order", delivered: false, first_sent_at: fresh },
      { entity_id: "c", event_name: "paid for order", delivered: true, first_sent_at: stale },
      { entity_id: "d", event_name: "placed order", delivered: false, first_sent_at: stale },
    ];
    expect(staleOmnisendClaims(rows, NOW)).toEqual([
      { entityId: "a", eventName: "paid for order" },
      { entityId: "d", eventName: "placed order" },
    ]);
  });

  it("leaves a claim with an unreadable timestamp alone", () => {
    const rows = [{ entity_id: "a", event_name: "paid for order", delivered: false, first_sent_at: null }];
    expect(staleOmnisendClaims(rows, NOW)).toEqual([]);
  });
});

describe("backstopFloorDecision", () => {
  const now = NOW.getTime();

  it("uses a recorded floor as it is", () => {
    const since = "2026-09-10T08:00:00.000Z";
    expect(backstopFloorDecision({ record: { value: { since }, unreadable: false }, now })).toEqual({
      action: "use",
      floor: Date.parse(since),
    });
  });

  // A refused read is not a first run. Stamping the floor again on a database
  // hiccup would move it forward past every order paid since the real floor,
  // and those orders would never be reported: the run must stand down instead.
  it("skips the run, and never stamps, when the record could not be read", () => {
    const decision = backstopFloorDecision({ record: { value: null, unreadable: true }, now });
    expect(decision.action).toBe("skip");
    expect(decision).toMatchObject({ skipped: expect.stringContaining("backstop floor unreadable") });
    expect(decision).not.toHaveProperty("floor");
  });

  // The key goes live and the first sweep tick can be a full cadence apart.
  // An order paid in between whose webhook after() died would be older than
  // a floor stamped at the tick and never reported, so the first floor is
  // one cadence back. It costs at most a cadence of pre-key orders, which is
  // what F-02 (a week of them) was about, not this.
  it("stamps a first run one sweep cadence before now, not at now", () => {
    expect(backstopFloorDecision({ record: { value: null, unreadable: false }, now })).toEqual({
      action: "stamp",
      floor: now - OMNISEND_BACKSTOP_FLOOR_GRACE_MS,
    });
  });

  it("re-stamps a record whose since is not a date, the same way as a first run", () => {
    expect(backstopFloorDecision({ record: { value: { since: "not a date" }, unreadable: false }, now })).toEqual({
      action: "stamp",
      floor: now - OMNISEND_BACKSTOP_FLOOR_GRACE_MS,
    });
    expect(backstopFloorDecision({ record: { value: {}, unreadable: false }, now }).action).toBe("stamp");
  });

  it("the grace is the sweep cadence in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const sweep = vercel.crons.find((cron) => cron.path === "/api/cron/sweep");
    expect(sweep).toBeDefined();
    const every = /^\*\/(\d+) \* \* \* \*$/.exec(sweep!.schedule);
    expect(every, `sweep schedule ${sweep!.schedule} is not every-N-minutes`).not.toBeNull();
    expect(OMNISEND_BACKSTOP_FLOOR_GRACE_MS).toBe(Number(every![1]) * 60 * 1000);
    expect(OMNISEND_BACKSTOP_FLOOR_GRACE_MS).toBe(30 * 60 * 1000);
  });
});

describe("backstopBudgetAllows", () => {
  // Fifty sequential onOrderPaid calls inside a 50-second cron watchdog is
  // not bounded; twenty seconds leaves the rest of the sweep its share.
  it("defaults to twenty seconds, inside the sweep's fifty-second watchdog", () => {
    expect(OMNISEND_BACKSTOP_BUDGET_MS).toBe(20_000);
    expect(OMNISEND_BACKSTOP_BUDGET_MS).toBeLessThan(50_000);
  });

  it("allows another order while the budget has not elapsed, and refuses at and beyond it", () => {
    const startedAtMs = NOW.getTime();
    expect(backstopBudgetAllows({ startedAtMs, nowMs: startedAtMs, budgetMs: 20_000 })).toBe(true);
    expect(backstopBudgetAllows({ startedAtMs, nowMs: startedAtMs + 19_999, budgetMs: 20_000 })).toBe(true);
    expect(backstopBudgetAllows({ startedAtMs, nowMs: startedAtMs + 20_000, budgetMs: 20_000 })).toBe(false);
    expect(backstopBudgetAllows({ startedAtMs, nowMs: startedAtMs + 60_000, budgetMs: 20_000 })).toBe(false);
  });

  it("a zero budget starts nothing", () => {
    const startedAtMs = NOW.getTime();
    expect(backstopBudgetAllows({ startedAtMs, nowMs: startedAtMs, budgetMs: 0 })).toBe(false);
  });
});

describe("backstopRunNotes", () => {
  it("is null when everything pending was attempted and nothing was released", () => {
    expect(backstopRunNotes({ pending: 3, attempted: 3, stale: 0, budgetExhausted: false })).toBeNull();
    expect(backstopRunNotes({ pending: 0, attempted: 0, stale: 0, budgetExhausted: false })).toBeNull();
  });

  it("counts released claims and what the batch limit left", () => {
    expect(backstopRunNotes({ pending: 3, attempted: 3, stale: 2, budgetExhausted: false })).toBe("2 stale claim(s) released");
    expect(backstopRunNotes({ pending: 60, attempted: 50, stale: 0, budgetExhausted: false })).toBe("10 left for the next run");
    expect(backstopRunNotes({ pending: 60, attempted: 50, stale: 1, budgetExhausted: false })).toBe(
      "1 stale claim(s) released; 10 left for the next run",
    );
  });

  it("says when the time budget, not the batch limit, is what stopped it", () => {
    expect(backstopRunNotes({ pending: 30, attempted: 7, stale: 0, budgetExhausted: true })).toBe(
      "23 left for the next run (time budget reached after 7)",
    );
  });
});

describe("cadenceDecision", () => {
  const interval = 6 * HOUR;

  it("is due when nothing has ever run", () => {
    expect(cadenceDecision({ lastRunAt: null, now: NOW.getTime(), intervalMs: interval })).toEqual({ due: true, skipped: null });
    expect(cadenceDecision({ lastRunAt: undefined, now: NOW.getTime(), intervalMs: interval })).toEqual({ due: true, skipped: null });
    expect(cadenceDecision({ lastRunAt: "", now: NOW.getTime(), intervalMs: interval })).toEqual({ due: true, skipped: null });
  });

  it("is not due inside the interval, and says how long ago it ran in whole minutes", () => {
    const lastRunAt = new Date(NOW.getTime() - 42 * 60 * 1000 - 30 * 1000).toISOString();
    expect(cadenceDecision({ lastRunAt, now: NOW.getTime(), intervalMs: interval })).toEqual({ due: false, skipped: "ran 42 minutes ago" });
  });

  it("is due exactly at the interval and beyond", () => {
    const at = new Date(NOW.getTime() - interval).toISOString();
    expect(cadenceDecision({ lastRunAt: at, now: NOW.getTime(), intervalMs: interval }).due).toBe(true);
    const past = new Date(NOW.getTime() - interval - 1).toISOString();
    expect(cadenceDecision({ lastRunAt: past, now: NOW.getTime(), intervalMs: interval }).due).toBe(true);
    const justUnder = new Date(NOW.getTime() - interval + 1000).toISOString();
    expect(cadenceDecision({ lastRunAt: justUnder, now: NOW.getTime(), intervalMs: interval }).due).toBe(false);
  });

  it("treats an unreadable or future stamp as due, so a bad record cannot stall the job for ever", () => {
    expect(cadenceDecision({ lastRunAt: "not a date", now: NOW.getTime(), intervalMs: interval }).due).toBe(true);
    const future = new Date(NOW.getTime() + DAY).toISOString();
    expect(cadenceDecision({ lastRunAt: future, now: NOW.getTime(), intervalMs: interval }).due).toBe(true);
  });

  it("uses singular for one minute", () => {
    const lastRunAt = new Date(NOW.getTime() - 60 * 1000).toISOString();
    expect(cadenceDecision({ lastRunAt, now: NOW.getTime(), intervalMs: interval })).toEqual({ due: false, skipped: "ran 1 minute ago" });
  });
});
