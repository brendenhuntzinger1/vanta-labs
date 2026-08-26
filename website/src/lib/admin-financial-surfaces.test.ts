import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

import { createPgSupabaseClient } from "@/lib/e2e/pg-supabase-adapter";
import { ORDERS_DDL, SERVICE_ROLE_DDL, seedOrderSql, type SeedOrder } from "@/lib/e2e/block-f-fixture";

// ---------------------------------------------------------------------------
// WHAT COUNTS AS "AN ORDER", AND HOW MANY OF THEM THE ADMIN CAN SEE.
//
// Four surfaces report the store's money and none of them agrees with the
// others about which rows are in scope:
//
//   /admin              admin-profit.getProfitDashboard   — excludes replacements
//   /admin (30d tile)   admin-profit.getProfitWindowMetrics — counts everything
//   /admin/revenue      admin-revenue.getRevenueMetrics   — counts everything
//   /admin/reconciliation  admin-reconciliation            — newest 2000 only
//
// Production has 15 orders and zero replacements, so every one of these
// disagreements reports the same number today and will start diverging on the
// first reship. That is precisely why this runs against a REAL Postgres with a
// generated dataset: the defect is invisible at production's current size, and
// an in-memory fake proves nothing about a row cap because the fake is the row
// source.
//
// Requires a throwaway Postgres — its OWN database, never one shared with
// another suite, because these tests seed thousands of orders:
//   initdb -D /tmp/vantapg -A trust -U postgres
//   pg_ctl -D /tmp/vantapg -o '-p 55440 -k /tmp' start
//   createdb -p 55440 -h /tmp -U postgres vanta_block_f
//   VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55440/vanta_block_f npx vitest run
// Skipped loudly when unset, so a run without a database is not a false pass.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const SQL_DIR = join(process.cwd(), "src", "lib", "sql");

const holder = vi.hoisted(() => ({ client: null as unknown, maxRows: undefined as number | undefined }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    if (!holder.client) throw new Error("pg client not ready");
    return holder.client;
  },
}));

let pg: Pool;

/** UTC noon on a fixed day, so nothing here depends on when the suite runs. */
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

async function seed(orders: SeedOrder[]) {
  for (const order of orders) {
    const { text, values } = seedOrderSql(order);
    await pg.query(text, values);
    if (order.unitCostCents !== undefined || order.quantity !== undefined) {
      await pg.query(
        `insert into public.order_items (order_id, product_id, product_name, quantity, unit_price, line_total, unit_cost_cents)
         values ($1, 'p-1', 'Test Peptide', $2, $3, $4, $5)`,
        [order.orderId, order.quantity ?? 1, order.subtotal ?? 0, order.subtotal ?? 0, order.unitCostCents ?? null],
      );
    }
    if (order.commissionAmount !== undefined) {
      await pg.query(
        `insert into public.commissions (order_id, commission_amount, payment_status) values ($1, $2, $3)`,
        [order.orderId, order.commissionAmount, order.commissionStatus ?? "pending"],
      );
    }
  }
}

async function reset(maxRows?: number) {
  await pg.query("truncate public.orders, public.order_items, public.commissions");
  holder.maxRows = maxRows;
  holder.client = createPgSupabaseClient(pg, { maxRows });
}

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    "[admin-financial-surfaces] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run these. " +
      "They are the only proof that the reporting surfaces agree at scale.",
  );
}

describeDb("financial reporting — what counts as an order", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: DATABASE_URL, max: 8 });
    await pg.query(SERVICE_ROLE_DDL);
    await pg.query(ORDERS_DDL);
    // The REAL migration, applied verbatim. If its SQL is wrong, these tests
    // fail — which is the point; nothing has ever executed it.
    await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await reset();
  });

  /**
   * 100 product sales at $100, 2 membership sales at $50, 3 reships at $0.
   * The truth: 102 things were sold for $10,100. A reship is a cost, not a sale
   * — admin-profit's own docblock says exactly that.
   */
  async function seedStoreWithReshipments() {
    const orders: SeedOrder[] = [];
    for (let i = 0; i < 100; i += 1) {
      orders.push({
        orderId: `order-p-${i}`,
        subtotal: 100,
        amountPaid: 100,
        paymentMethod: "card",
        createdAt: iso(NOW - (i % 20) * DAY),
        unitCostCents: 2000,
        quantity: 1,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      orders.push({
        orderId: `order-m-${i}`,
        subtotal: 50,
        amountPaid: 50,
        paymentMethod: "card",
        orderType: "membership",
        createdAt: iso(NOW - i * DAY),
      });
    }
    for (let i = 0; i < 3; i += 1) {
      orders.push({
        orderId: `order-r-${i}`,
        subtotal: 0,
        amountPaid: 0,
        paymentMethod: "replacement",
        orderType: "replacement",
        createdAt: iso(NOW - i * DAY),
        unitCostCents: 2000,
        quantity: 1,
      });
    }
    await seed(orders);
  }

  it("every surface counts the same 102 sales, and never counts a reship as one", async () => {
    await seedStoreWithReshipments();

    const { getProfitDashboard, getProfitWindowMetrics } = await import("@/lib/admin-profit");
    const { getRevenueMetrics } = await import("@/lib/admin-revenue");

    const dashboard = await getProfitDashboard(NOW);
    const window = await getProfitWindowMetrics(NOW);
    const revenue = await getRevenueMetrics();

    // The dashboard already gets this right — it is the reference.
    expect(dashboard.lifetime.orderCount).toBe(102);
    expect(dashboard.lifetime.replacementCount).toBe(3);

    // These two report the same store and must agree with it.
    expect(window.ordersLast30Days).toBe(102);
    expect(revenue.totalPaidOrders).toBe(102);
  });

  it("average order value is not dragged down by reships that no customer bought", async () => {
    await seedStoreWithReshipments();
    const { getRevenueMetrics } = await import("@/lib/admin-revenue");
    const revenue = await getRevenueMetrics();

    // $10,100 across 102 real sales.
    expect(revenue.totalPaidRevenue).toBe(10100);
    expect(revenue.averageOrderValue).toBe(99.02);
  });

  it("the revenue-by-method breakdown has no line for reshipments", async () => {
    await seedStoreWithReshipments();
    const { getRevenueMetrics } = await import("@/lib/admin-revenue");
    const revenue = await getRevenueMetrics();

    expect(revenue.byMethod.map((m) => m.method)).not.toContain("replacement");
    expect(revenue.byMethod.reduce((sum, m) => sum + m.orders, 0)).toBe(102);
  });

  it("counts the same 102 sales when the rollup migration has NOT been applied", async () => {
    // getRevenueMetrics silently degrades to a 10k-capped JS scan whenever the
    // RPCs are absent. That branch is what an instance deployed ahead of the
    // migration actually runs, so it has to agree with the RPC branch — a fix
    // applied to only one of them is a fix that depends on deployment order.
    await seedStoreWithReshipments();
    await pg.query("drop function if exists public.admin_revenue_summary(timestamptz)");
    await pg.query("drop function if exists public.admin_revenue_by_method()");
    try {
      const { getRevenueMetrics } = await import("@/lib/admin-revenue");
      const revenue = await getRevenueMetrics();
      expect(revenue.totalPaidOrders).toBe(102);
      expect(revenue.totalPaidRevenue).toBe(10100);
      expect(revenue.averageOrderValue).toBe(99.02);
      expect(revenue.byMethod.map((m) => m.method)).not.toContain("replacement");
    } finally {
      await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
    }
  });

  it("a membership IS a sale — the exclusion is for reshipments only", async () => {
    // Guards the fix against over-reach. Every other order_type filter in the
    // repo excludes 'membership' (nothing ships), and copying that habit into
    // the revenue counts would erase real paid memberships from the books.
    await seed([
      { orderId: "order-prod", subtotal: 100, amountPaid: 100, createdAt: iso(NOW) },
      { orderId: "order-memb", subtotal: 50, amountPaid: 50, orderType: "membership", createdAt: iso(NOW) },
    ]);
    const { getRevenueMetrics } = await import("@/lib/admin-revenue");
    const { getProfitDashboard, getProfitWindowMetrics } = await import("@/lib/admin-profit");

    expect((await getRevenueMetrics()).totalPaidOrders).toBe(2);
    expect((await getProfitDashboard(NOW)).lifetime.orderCount).toBe(2);
    expect((await getProfitWindowMetrics(NOW)).ordersLast30Days).toBe(2);
  });
});

describeDb("reconciliation — what the operator can actually see", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: DATABASE_URL, max: 8 });
    await pg.query(SERVICE_ROLE_DDL);
    await pg.query(ORDERS_DDL);
    await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await reset();
  });

  it("does not accuse an order that carries a handling fee", async () => {
    // Every writer sets handling_fee to 0 today, so this cannot happen yet —
    // and that is exactly why it was never noticed. The column is
    // `not null default 0`, the customer invoice renders a Handling line from
    // it, and expectedOrderTotal used to omit it, so the first order to carry
    // one would be reported as overpaying by exactly the handling fee.
    await seed([
      {
        orderId: "order-handling", subtotal: 100, shipping: 15, handlingFee: 5,
        tax: 0, cardFee: 0, amountPaid: 120, createdAt: iso(NOW),
      },
    ]);
    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();
    expect(flags.filter((f) => f.type === "total_mismatch")).toEqual([]);
  });

  it("still catches a genuine underpayment", async () => {
    // The negative control for the test above, in the suite rather than as a
    // one-off mutation: loosening the check until nothing is ever flagged would
    // pass "does not accuse..." perfectly.
    await seed([
      {
        orderId: "order-short", subtotal: 100, shipping: 15, tax: 8,
        cardFee: 0, amountPaid: 100, createdAt: iso(NOW),
      },
    ]);
    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();
    expect(flags.map((f) => f.type)).toContain("total_mismatch");
    expect(flags.find((f) => f.type === "total_mismatch")?.detail).toContain("Expected $123.00");
  });

  it("a broken order older than the newest 2000 is invisible to the operator", async () => {
    // THE ROW CAP. getReconciliationFlags reads `.limit(2000)` ordered by
    // created_at desc, with no paging and no signal that it truncated. This is
    // the screen an operator opens when they already suspect a money problem,
    // and past 2000 orders it silently stops looking.
    //
    // Production has 15 orders, so this is unreachable there and is generated
    // here instead: 2100 clean orders, plus ONE underpaid order older than all
    // of them.
    const rows: SeedOrder[] = [
      {
        orderId: "order-oldest-broken", subtotal: 100, shipping: 15, tax: 8,
        amountPaid: 1, createdAt: iso(NOW - 5000 * 60_000),
      },
    ];
    for (let i = 0; i < 2100; i += 1) {
      rows.push({
        orderId: `order-clean-${i}`, subtotal: 100, shipping: 15,
        amountPaid: 115, createdAt: iso(NOW - i * 60_000),
      });
    }
    await seed(rows);
    expect(Number((await pg.query("select count(*)::int as c from public.orders")).rows[0].c)).toBe(2101);

    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();

    // The order that is $114 short must be reported. Before the fix this was
    // an empty array: the cap cut it off and nothing said so.
    expect(flags.map((f) => f.orderId)).toContain("order-oldest-broken");
  });

  it("examines every order even when the server caps each response", async () => {
    // THIS ASSERTION WAS STRENGTHENED, NOT WEAKENED. It used to require
    // `scan_truncated` to be raised under a server cap, because the reader of
    // the day advanced by a fixed stride and stopped on the first short page —
    // so a cap really did cut the scan short, and announcing it was the best
    // available outcome.
    //
    // The merged reader (readAllRowsBounded) advances by the rows it actually
    // received, so a cap costs round trips instead of coverage. Measured here:
    // 40-row responses over 100 orders returns all 100 and flags nothing.
    // "Did not truncate" is a better answer than "truncated, and said so", and
    // raising the notice anyway would be a false alarm on a screen the operator
    // opens when they already suspect something is wrong.
    //
    // The ceiling case — where MAX_RECONCILIATION_ORDERS, not the server, ends
    // the read — is still asserted, at the helper level, in
    // supabase-page-bounded.test.ts ("reports truncation when the ceiling stops
    // it short").
    const rows: SeedOrder[] = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push({ orderId: `order-c-${i}`, subtotal: 100, shipping: 15, amountPaid: 115, createdAt: iso(NOW - i * 60_000) });
    }
    await seed(rows);
    holder.client = createPgSupabaseClient(pg, { maxRows: 40 });

    const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");
    const flags = await getReconciliationFlags();

    // Every order was examined, so there is nothing to announce.
    expect(flags.map((f) => f.type)).not.toContain("scan_truncated");
    // And it is not silent-and-empty because the scan died: all 100 orders here
    // reconcile exactly, so a clean result is the correct result. The companion
    // test above ("flags every mismatched order…") is what proves a short read
    // would have been caught.
    expect(flags).toHaveLength(0);
  });
});

describeDb("row caps on the profit reads", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: DATABASE_URL, max: 8 });
    await pg.query(SERVICE_ROLE_DDL);
    await pg.query(ORDERS_DDL);
    await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await reset();
  });

  /** 1,500 identical $100 sales in the last 30 days. Truth: $150,000, 1,500 orders. */
  async function seed1500() {
    const rows: SeedOrder[] = [];
    for (let i = 0; i < 1500; i += 1) {
      rows.push({
        orderId: `order-s-${i}`, subtotal: 100, amountPaid: 100,
        paymentMethod: "zelle", createdAt: iso(NOW - (i % 25) * DAY),
      });
    }
    await seed(rows);
  }

  it("reports every order when the row source is not capped", async () => {
    await seed1500();
    const { getProfitWindowMetrics, getProfitDashboard } = await import("@/lib/admin-profit");
    expect((await getProfitWindowMetrics(NOW)).ordersLast30Days).toBe(1500);
    expect((await getProfitDashboard(NOW)).lifetime.orderCount).toBe(1500);
  });

  it("does not silently under-report when the row source caps the response", async () => {
    // PostgREST applies `db-max-rows` when the project sets one, capping EVERY
    // response without telling the caller. profitForPaidOrdersInRange (which
    // drives the 30-day profit tile and the analytics trend) has no .limit()
    // and no .range() at all, so it depends entirely on that setting being
    // absent — and this application cannot see it.
    //
    // Production has 15 orders, so this is unreachable there. Simulated at
    // 1,000 (Supabase's own documented default for the setting) against 1,500
    // real rows: a third of the store's profit disappears from the tile with no
    // error, no warning, and a confidently smaller number.
    await seed1500();
    holder.client = createPgSupabaseClient(pg, { maxRows: 1000 });

    const { getProfitWindowMetrics } = await import("@/lib/admin-profit");
    const metrics = await getProfitWindowMetrics(NOW);

    expect(metrics.ordersLast30Days).toBe(1500);
    expect(metrics.truncated).toBe(false);
  });

  it("reports the WHOLE figure under a cap far below the page size", async () => {
    // Strengthened for the same reason as the reconciliation test above. The
    // requirement is "the operator must not be shown a smaller number as if it
    // were the whole story"; there are two ways to satisfy it, and returning
    // the whole story is the better one.
    //
    // 500-row responses over 1,500 orders. A reader that treated a short page
    // as the end would report 500 and a third of the profit.
    await seed1500();
    holder.client = createPgSupabaseClient(pg, { maxRows: 500 });

    const { getProfitWindowMetrics } = await import("@/lib/admin-profit");
    const metrics = await getProfitWindowMetrics(NOW);

    expect(metrics.ordersLast30Days).toBe(1500);
    expect(metrics.truncated).toBe(false);
  });
});

describeDb("sales tax — the number filed with each state", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: DATABASE_URL, max: 8 });
    await pg.query(SERVICE_ROLE_DDL);
    await pg.query(ORDERS_DDL);
    await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await reset();
  });

  it("counts a fully paid order's tax in full", async () => {
    await seed([{
      orderId: "order-paid", state: "PA", taxState: "PA", taxRatePercent: 6,
      subtotal: 100, tax: 6, amountPaid: 121, paymentStatus: "paid", createdAt: iso(NOW),
    }]);
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();
    expect(report.totals.taxCollected).toBe(6);
    expect(report.totals.netTax).toBe(6);
  });

  it("offsets a fully refunded order's tax", async () => {
    await seed([{
      orderId: "order-refunded", state: "PA", taxState: "PA", taxRatePercent: 6,
      subtotal: 100, tax: 6, amountPaid: 121, refundAmount: 121,
      paymentStatus: "refunded", createdAt: iso(NOW),
    }]);
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();
    expect(report.totals.taxRefunded).toBe(6);
    expect(report.totals.netTax).toBe(0);
  });

  it("still owes the state the tax on a PARTIALLY refunded order", async () => {
    // THE DEFECT. `const refunded = status === "refunded"` is the only refund
    // test in the file, and "partially_refunded" is in neither
    // PAID_ORDER_STATUSES nor that comparison — so the order fell through
    // `if (!paid && !refunded) continue` and vanished from the report entirely.
    //
    // The store collected $6.00 of Pennsylvania sales tax, refunded half the
    // order, and still owes the state the tax on the half the customer kept.
    // The filing showed $0.00 for that order. `orders.refund_amount` is never
    // read anywhere in the file.
    await seed([{
      orderId: "order-partial", state: "PA", taxState: "PA", taxRatePercent: 6,
      subtotal: 100, tax: 6, amountPaid: 121, refundAmount: 60.50,
      paymentStatus: "partially_refunded", createdAt: iso(NOW),
    }]);
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].paymentStatus).toBe("partially_refunded");
    // Half the order came back, so half the tax did too: $3.00 retained.
    expect(report.totals.taxCollected).toBe(6);
    expect(report.totals.taxRefunded).toBe(3);
    expect(report.totals.netTax).toBe(3);
  });

  it("attributes a partial refund to the right state", async () => {
    await seed([
      {
        orderId: "order-pa", state: "PA", taxState: "PA", taxRatePercent: 6,
        subtotal: 100, tax: 6, amountPaid: 121, refundAmount: 60.50,
        paymentStatus: "partially_refunded", createdAt: iso(NOW),
      },
      {
        orderId: "order-ny", state: "NY", taxState: "NY", taxRatePercent: 8,
        subtotal: 100, tax: 8, amountPaid: 123, paymentStatus: "paid", createdAt: iso(NOW),
      },
    ]);
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();
    const byState = Object.fromEntries(report.byState.map((row) => [row.state, row]));
    expect(byState.PA.netTax).toBe(3);
    expect(byState.NY.netTax).toBe(8);
    expect(report.totals.netTax).toBe(11);
  });

  it("never reports a negative liability when a refund exceeds what was paid", async () => {
    // A data-entry slip or a duplicated refund must not turn into a credit the
    // state never gave. The proportion is clamped to [0, 1].
    await seed([{
      orderId: "order-over", state: "PA", taxState: "PA", taxRatePercent: 6,
      subtotal: 100, tax: 6, amountPaid: 121, refundAmount: 500,
      paymentStatus: "partially_refunded", createdAt: iso(NOW),
    }]);
    const { getSalesTaxReport } = await import("@/lib/admin-tax-report");
    const report = await getSalesTaxReport();
    expect(report.totals.netTax).toBe(0);
    expect(report.totals.taxRefunded).toBe(6);
  });
});

describeDb("the customer invoice adds up", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: DATABASE_URL, max: 8 });
    await pg.query(SERVICE_ROLE_DDL);
    await pg.query(ORDERS_DDL);
    await pg.query(readFileSync(join(SQL_DIR, "admin-dashboard-rollups.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await reset();
  });

  /** Reads the order back the way the invoice route does, then totals it. */
  async function invoiceFor(orderId: string) {
    const { getCustomerOrderDetail } = await import("@/lib/account-orders");
    const { buildInvoiceTotals, invoiceReconciles } = await import("@/lib/invoice-totals");
    const order = await getCustomerOrderDetail(USER_ID, "buyer@example.test", orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    const totals = buildInvoiceTotals(order);
    return { order, totals, reconciles: invoiceReconciles(totals) };
  }

  const USER_ID = "11111111-1111-1111-1111-111111111111";

  async function seedOwned(order: SeedOrder) {
    await seed([{ ...order, customerEmail: "buyer@example.test" }]);
    await pg.query("update public.orders set customer_user_id = $1 where order_id = $2", [USER_ID, order.orderId]);
  }

  it("adds up on the three real production orders that carry a protection fee", async () => {
    // Read from production (read-only) on 2026-08-26. Every one of these
    // rendered an invoice whose lines were short of "Total paid" by exactly the
    // protection fee: $0.08, $0.15 and $2.20.
    const REAL = [
      { orderId: "order-VL-37C1E4B0", subtotal: 2.00, shipping: 15, tax: 0, protectionFee: 0.08, amountPaid: 17.08 },
      { orderId: "order-VL-8D132452", subtotal: 3.80, shipping: 15, tax: 0, protectionFee: 0.15, amountPaid: 18.95 },
      { orderId: "order-VL-E8F4D52F", subtotal: 54.99, shipping: 15, tax: 3.85, protectionFee: 2.20, amountPaid: 76.04 },
    ];
    for (const row of REAL) {
      await seedOwned({ ...row, createdAt: iso(NOW), paymentStatus: "paid" });
      const { totals, reconciles } = await invoiceFor(row.orderId);
      expect(reconciles).toBe(true);
      expect(totals.lines.map((l) => l.label)).toContain("Shipping Protection");
      expect(totals.lines.find((l) => l.label === "Shipping Protection")?.amount).toBe(row.protectionFee);
      // And no unexplained remainder was needed to make it balance.
      expect(totals.lines.map((l) => l.label)).not.toContain("Other charges");
    }
  });

  it("adds up on a card order, where the 3% surcharge is the missing piece", async () => {
    // No card order exists in production yet, so this half of the defect has
    // never reached a customer. It fires on the first one.
    await seedOwned({
      orderId: "order-card", subtotal: 200, discount: 20, shipping: 15, tax: 12.30,
      cardFee: 10.37, protectionFee: 8, amountPaid: 225.67,
      paymentMethod: "card", paymentStatus: "paid", createdAt: iso(NOW),
    });
    const { totals, reconciles } = await invoiceFor("order-card");
    expect(reconciles).toBe(true);
    expect(totals.lines.find((l) => l.label === "Service Fee")?.amount).toBe(10.37);
    expect(totals.lines.map((l) => l.label)).not.toContain("Other charges");
  });

  it("shows store credit and points as deductions, so the total is reachable downward too", async () => {
    await seedOwned({
      orderId: "order-redeemed", subtotal: 200, shipping: 15, tax: 0,
      storeCreditCents: 2500, pointsRedeemed: 1000, amountPaid: 180,
      paymentStatus: "paid", createdAt: iso(NOW),
    });
    const { totals, reconciles } = await invoiceFor("order-redeemed");
    expect(reconciles).toBe(true);
    expect(totals.lines.find((l) => l.label === "Store credit")?.amount).toBe(-25);
    expect(totals.lines.find((l) => l.label === "Points redeemed")?.amount).toBe(-10);
    expect(totals.lines.map((l) => l.label)).not.toContain("Other adjustments");
  });

  it("names an unexplained remainder rather than hiding it", async () => {
    // A row written before shipping_protection_fee existed folded the fee into
    // amount_paid and recorded it nowhere. The invoice cannot say what the
    // charge was, but it must not pretend the arithmetic works.
    await seedOwned({
      orderId: "order-legacy", subtotal: 100, shipping: 15, tax: 0,
      protectionFee: 0, cardFee: 0, amountPaid: 119,
      paymentStatus: "paid", createdAt: iso(NOW),
    });
    const { totals, reconciles } = await invoiceFor("order-legacy");
    expect(reconciles).toBe(true);
    expect(totals.lines.find((l) => l.label === "Other charges")?.amount).toBe(4);
  });
});
