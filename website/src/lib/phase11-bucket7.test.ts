import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 7 — regression cover for five polish fixes.
//
// One fake PostgREST serves all of them, because all five defects are about
// what the database layer actually returns or actually rejects:
//
//   F-A-18  best-sellers read 3000 orders with `.limit(3000)` against a server
//           that silently returns 1000, and read order LINES with no bound at
//           all. The cap below is the whole point of this double: it truncates
//           without an error, exactly as Supabase does.
//   DUP-08  setReferralCodeLock ran its two writes concurrently and read
//           neither result, so a rejected write on the gating table reported
//           success.
//   REF-04  a standing "could not complete these refund side-effects" alert was
//           re-raised on every sweep — 48 CRITICAL operator emails a day for one
//           unchanging fact.
//   ADM-06  the customers table called a count of checkouts "Orders" and linked
//           to a list that hides half of them (source assertions).
//   RLS-07  the anon column grants handed out raw stock depth the catalogue API
//           deliberately clamps (source assertions).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  orders: [],
  order_items: [],
  ambassadors: [],
  partners: [],
  points_ledger: [],
  store_credit_ledger: [],
  system_alerts: [],
};

const state = {
  /** Every UPDATE attempted, in the order it was issued. */
  writes: [] as Array<{ table: string; patch: Row }>,
  /** Make writes to this table come back rejected, as RLS or a constraint would. */
  failWriteOn: null as string | null,
  /**
   * PostgREST's `max-rows`. Supabase ships 1000 and enforces it SILENTLY: the
   * response is a valid array that simply stops.
   */
  responseCap: 1000,
};

const effects = vi.hoisted(() => ({
  reverseOrderPoints: vi.fn(),
  restoreRedeemedPoints: vi.fn(),
  refundStoreCreditForOrder: vi.fn(),
  recordSystemAlert: vi.fn(),
}));

vi.mock("@/lib/membership", () => ({
  reverseOrderPoints: effects.reverseOrderPoints,
  restoreRedeemedPoints: effects.restoreRedeemedPoints,
}));

vi.mock("@/lib/store-credit", async () => {
  // The date/amount rules are pure and must be the real ones.
  const real = await vi.importActual<typeof import("@/lib/store-credit")>("@/lib/store-credit");
  return {
    isRefundableRedemption: real.isRefundableRedemption,
    startOfCurrentMonthIso: real.startOfCurrentMonthIso,
    refundStoreCreditForOrder: effects.refundStoreCreditForOrder,
  };
});

vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: effects.recordSystemAlert }));

vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const rows = db[table] ?? (db[table] = []);
    const filters: Array<(row: Row) => boolean> = [];
    const sortKeys: Array<{ col: string; asc: boolean }> = [];
    let action: "select" | "update" = "select";
    let patch: Row = {};
    let take: number | null = null;
    let skip = 0;

    function settle() {
      if (action === "update") {
        state.writes.push({ table, patch: { ...patch } });
        if (state.failWriteOn === table) {
          return { data: null, error: { message: `${table} write rejected` } };
        }
        const hit = rows.filter((row) => filters.every((f) => f(row)));
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      }

      let out = rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row }));
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
      // THE SILENT TRUNCATION. No error, no flag — the array just stops.
      if (out.length > state.responseCap) out = out.slice(0, state.responseCap);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      update(next: Row) { action = "update"; patch = next; return b; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      not() { return b; },
      gte(col: string, value: unknown) {
        filters.push((row) => row[col] != null && String(row[col]) >= String(value));
        return b;
      },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return b; },
      // The refund sweep's window expression is a nested or()/and() the sweep's
      // own suite already parses in full. This one accepts it: every fixture
      // here is a refunded order well inside the window, so the window is not
      // what any test below is about.
      or() { return b; },
      order(col: string, opts?: { ascending?: boolean }) {
        sortKeys.push({ col, asc: opts?.ascending !== false });
        return b;
      },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) { skip = from; take = to - from + 1; return b; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }

  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of Object.keys(db)) db[table] = [];
  state.writes = [];
  state.failWriteOn = null;
  state.responseCap = 1000;
  effects.recordSystemAlert.mockImplementation(async (alert: Row) => {
    db.system_alerts.push({
      ...alert,
      created_at: new Date(Date.now() + db.system_alerts.length).toISOString(),
      resolved_at: null,
    });
  });
});

// ---------------------------------------------------------------------------
// F-A-18 — the best-seller scan is bounded by rows it ASKED for, not rows the
// server is willing to return.
// ---------------------------------------------------------------------------
describe("best sellers, against a server that caps responses at 1000 rows", () => {
  const HOUR = 60 * 60 * 1000;

  async function bestSellers(limit: number): Promise<Set<string>> {
    // The module caches its answer for five minutes, so each test needs a fresh
    // copy of it.
    vi.resetModules();
    const { getBestSellerSlugs } = await import("@/lib/best-sellers");
    return getBestSellerSlugs(limit);
  }

  it("reads the whole 3000-order lookback it claims to, not the first 1000", async () => {
    // 1400 orders inside the window. The oldest 400 sold a product the newest
    // 1000 never did, and `.order(created_at desc).limit(3000)` against a
    // 1000-row cap could never reach them.
    for (let i = 0; i < 1400; i += 1) {
      const orderId = `o${String(i).padStart(4, "0")}`;
      db.orders.push({
        order_id: orderId,
        payment_status: "paid",
        order_type: null,
        created_at: new Date(Date.UTC(2026, 7, 20) - i * HOUR).toISOString(),
      });
      db.order_items.push({
        id: String(i).padStart(6, "0"),
        order_id: orderId,
        product_id: i < 1000 ? "alpha::10mg" : "beta::10mg",
        quantity: 1,
      });
    }

    const slugs = await bestSellers(10);

    expect(slugs.has("alpha")).toBe(true);
    expect(slugs.has("beta")).toBe(true);
  });

  it("reads every order LINE of a chunk, which is not bounded by the chunk size", async () => {
    // 150 orders — one whole chunk — of ten lines each. order_items returns one
    // row per LINE, so the chunk size chosen for URL length is 1500 rows here,
    // and the last 500 of them sold a different product.
    for (let i = 0; i < 150; i += 1) {
      const orderId = `o${String(i).padStart(4, "0")}`;
      db.orders.push({
        order_id: orderId,
        payment_status: "paid",
        order_type: null,
        created_at: new Date(Date.UTC(2026, 7, 20) - i * HOUR).toISOString(),
      });
      for (let line = 0; line < 10; line += 1) {
        const seq = i * 10 + line;
        db.order_items.push({
          id: String(seq).padStart(6, "0"),
          order_id: orderId,
          product_id: seq < 1000 ? "alpha::10mg" : "gamma::10mg",
          quantity: 1,
        });
      }
    }

    const slugs = await bestSellers(10);

    expect(slugs.has("alpha")).toBe(true);
    expect(slugs.has("gamma")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DUP-08 — the lock is a gate on `ambassadors`; `partners` is a display mirror.
// ---------------------------------------------------------------------------
describe("setReferralCodeLock", () => {
  beforeEach(() => {
    db.ambassadors = [{ id: "amb-1", referral_code_locked: false }];
    db.partners = [{ id: "amb-1", referral_code_locked: false }];
  });

  it("writes the gate first and the mirror second", async () => {
    const { setReferralCodeLock } = await import("@/lib/referral-code-service");
    await setReferralCodeLock("amb-1", true);

    expect(state.writes.map((write) => write.table)).toEqual(["ambassadors", "partners"]);
    expect(db.ambassadors[0].referral_code_locked).toBe(true);
    expect(db.partners[0].referral_code_locked).toBe(true);
  });

  it("throws when the gate write is rejected, and never mirrors a lock that is not in force", async () => {
    // The concurrent version read neither result: this returned void, the
    // caller was told the code was locked, and `partners` carried a lock the
    // storefront was not enforcing.
    state.failWriteOn = "ambassadors";
    const { setReferralCodeLock } = await import("@/lib/referral-code-service");

    await expect(setReferralCodeLock("amb-1", true)).rejects.toThrow(/ambassadors write rejected/);

    expect(state.writes.map((write) => write.table)).toEqual(["ambassadors"]);
    expect(db.partners[0].referral_code_locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REF-04 — a standing failure is one alert, not one alert every thirty minutes.
// ---------------------------------------------------------------------------
describe("the refund-effect repair alert", () => {
  function refundedOrder(orderId: string): Row {
    // refund_amount already recorded and no store credit, so the ONLY effect
    // planned is the points reversal — which the mock below always fails.
    return {
      id: `row-${orderId}`,
      order_id: orderId,
      payment_status: "refunded",
      refund_amount: 4999,
      points_earned: 120,
      points_redeemed: 0,
      store_credit_redeemed_cents: 0,
      amount_paid: 4999,
      customer_user_id: "user-1",
      refunded_at: null,
      updated_at: "2026-08-20T00:00:00Z",
    };
  }

  const unrecovered = () => db.system_alerts.filter((row) => row.type === "refund_effects_unrecovered");

  beforeEach(() => {
    effects.reverseOrderPoints.mockRejectedValue(new Error("points ledger unavailable"));
    effects.restoreRedeemedPoints.mockResolvedValue(false);
    effects.refundStoreCreditForOrder.mockResolvedValue(false);
  });

  it("is written once for an unchanging set of failures, not once per sweep", async () => {
    db.orders = [refundedOrder("order-1")];
    const { repairIncompleteRefunds } = await import("@/lib/refund-effect-repair");

    for (let tick = 0; tick < 5; tick += 1) {
      const result = await repairIncompleteRefunds();
      expect(result.failed).toBe(1);
    }

    expect(unrecovered()).toHaveLength(1);
  });

  it("still reports a NEW failure while the old one stands", async () => {
    // The reason the dedup is on the failing SET and not on the alert type: a
    // type-level dedup would silence exactly the alert that is news.
    db.orders = [refundedOrder("order-1")];
    const { repairIncompleteRefunds } = await import("@/lib/refund-effect-repair");
    await repairIncompleteRefunds();

    db.orders.push(refundedOrder("order-2"));
    await repairIncompleteRefunds();

    expect(unrecovered()).toHaveLength(2);
    expect(unrecovered()[1].context).toMatchObject({ totalFailed: 2 });
  });

  it("reports again once a human resolves the row", async () => {
    db.orders = [refundedOrder("order-1")];
    const { repairIncompleteRefunds } = await import("@/lib/refund-effect-repair");
    await repairIncompleteRefunds();

    for (const row of db.system_alerts) row.resolved_at = new Date().toISOString();
    await repairIncompleteRefunds();

    expect(unrecovered()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ADM-06 / RLS-07 — source assertions, for the same reason
// client-key-table-access.test.ts is one: neither behaviour is reachable from a
// unit test (one is an admin page's rendered header, the other is a production
// GRANT), and the local harness carries its own grants.
// ---------------------------------------------------------------------------
const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("the admin customers table says what it counts", () => {
  const page = read("src/app/admin/customers/page.tsx");

  it("does not call a count of checkouts 'Orders'", () => {
    // admin-customers.ts increments orderCount for EVERY checkout row while
    // totalSpent beside it is filtered to paid statuses, so an abandoned
    // checkout is in one column and not the other.
    expect(page).toContain(">Checkouts</th>");
    expect(page).not.toContain(">Orders</th>");
  });

  it("links to the same set of rows the number counted", () => {
    // /admin/orders defaults to the "active" filter, which drops
    // pending_payment and canceled rows.
    expect(page).toContain("&paymentStatus=all");
    // ...and "all" has to be a filter the orders list actually honours.
    expect(read("src/lib/admin-orders.ts")).toContain('filters.paymentStatus !== "all"');
  });
});

describe("the public column grants do not publish shelf depth", () => {
  const DEPTH_COLUMNS = ["inventory_quantity", "reserved_quantity", "incoming_quantity", "low_stock_threshold"];

  /** The granted column list only — comments inside it name these columns to explain their absence. */
  function grantedColumns(sql: string): string[] {
    const body = sql.slice(sql.indexOf("grant select ("), sql.indexOf(") on public."));
    return body
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim().replace(/,$/, ""))
      .filter((line) => /^\w+$/.test(line));
  }

  for (const file of [
    "src/lib/sql/products-hide-cost-columns-from-public.sql",
    "src/lib/sql/product-doses-hide-cost-columns-from-public.sql",
  ]) {
    it(`${file} grants the badge, not the count`, () => {
      const granted = grantedColumns(read(file));
      // The storefront's In Stock / Low stock badge still has to work.
      expect(granted).toContain("stock_status");
      expect(granted).toContain("track_inventory");
      for (const column of DEPTH_COLUMNS) {
        expect(granted, `${column} is still granted to anon`).not.toContain(column);
      }
    });
  }

  it("has a migration that takes the four columns back from anon", () => {
    const migration = read("src/lib/sql/migrations-applied/20260828T_revoke_anon_inventory_columns.sql");
    for (const table of ["public.products", "public.product_doses"]) {
      const statement = migration
        .split(";")
        .find((chunk) => chunk.includes("revoke select") && chunk.includes(table));
      expect(statement, `no revoke for ${table}`).toBeTruthy();
      for (const column of DEPTH_COLUMNS) {
        expect(statement).toContain(column);
      }
      expect(statement).toContain("from anon, authenticated");
    }
  });
});

// ---------------------------------------------------------------------------
// SQL-03 — inventory-reservations.sql still defines the DORMANT reserve_inventory
// (enforcing only when track_inventory = true). The harness applies the
// superseding file after it and asserts the wider predicate; the header has to
// say so, because re-running this file anywhere else silently reverts
// oversell prevention.
// ---------------------------------------------------------------------------
describe("the superseded reservation migration warns that it is superseded", () => {
  it("names the file that must be re-run after it", () => {
    const header = read("src/lib/sql/inventory-reservations.sql").split("create table")[0];
    expect(header).toContain("SUPERSEDED");
    expect(header).toContain("inventory-enforce-positive-stock.sql");
  });

  it("is applied before that file by the harness, which then checks the predicate", () => {
    const harness = read("scripts/setup-local-harness.sh");
    expect(harness.indexOf("inventory-enforce-positive-stock"))
      .toBeGreaterThan(harness.indexOf("inventory-reservations"));
    expect(harness).toContain("inventory_quantity > 0");
  });
});
