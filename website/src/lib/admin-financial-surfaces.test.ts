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
