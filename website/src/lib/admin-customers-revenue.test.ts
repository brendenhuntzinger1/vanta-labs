import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "TOTAL SPENT" IS REVENUE, SO IT USES THE REVENUE DEFINITION.
//
// The customer list's lifetime-value column summed raw `amount_paid` for any
// order in a paid-ish status. A fully refunded order therefore counted its
// whole face value forever, and a partially refunded one counted the part that
// had been handed back — a tenth revenue definition in a codebase whose whole
// point is that there is one, and one the profit/revenue census missed.
//
// `ledger.netOrderRevenue` is that one definition (`max(0, paid − refunded)`),
// mirrored in admin-dashboard-rollups.sql and used by /admin/revenue,
// analytics, email attribution and membership revenue.
//
// Which ROWS are counted is deliberately unchanged here: `orderCount` still
// counts the order, because the customer did place it. Only the money moves.
//
// THE SQL WAS ALREADY RIGHT. `admin_customer_rollup` in
// src/lib/sql/admin-dashboard-rollups.sql:145 sums
// `round(greatest(0, amount_paid - refund_amount), 2)` over exactly the same
// three statuses. That RPC is the primary path; this JS aggregation is the
// fallback for an environment where the migration has not been applied — so
// the two were reporting DIFFERENT lifetime values for the same customer
// depending on which path ran. These cases pin the fallback to the SQL.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const state = { orders: [] as Row[] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    // `neq` FILTERS FOR REAL rather than returning the builder untouched.
    // aggregateCustomers excludes warranty replacements (M-14), and a double
    // that swallowed the filter would let the replacement case below pass
    // against code that never applied it — which is the whole thing that case
    // exists to prove.
    const rejects: Array<(row: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      not: () => api,
      neq: (column: string, value: unknown) => {
        rejects.push((row) => String(row[column] ?? "") === String(value));
        return api;
      },
      order: () => api,
      limit: () =>
        Promise.resolve({
          data: state.orders.filter((row) => !rejects.some((reject) => reject(row))),
          error: null,
        }),
    };
    return api;
  };
  return {
    supabaseAdmin: {
      from: () => builder(),
      // Drive the LEGACY path: the RPC is the primary one, and this suite is
      // about the JS fallback that had drifted away from it.
      rpc: async () => ({ data: null, error: { code: "42883", message: "function admin_customer_rollup does not exist" } }),
    },
  };
});

const { getAdminCustomers } = await import("@/lib/admin-customers");

function order(overrides: Row = {}): Row {
  return {
    customer_email: "buyer@example.test",
    customer_name: "Buyer",
    amount_paid: 200,
    refund_amount: 0,
    payment_status: "paid",
    created_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

async function only() {
  const result = await getAdminCustomers({});
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

beforeEach(() => {
  state.orders = [];
});

describe("customer lifetime value", () => {
  it("counts a clean paid order at face value", async () => {
    state.orders = [order()];
    const row = await only();
    expect(row.totalSpent).toBe(200);
    expect(row.orderCount).toBe(1);
  });

  it("subtracts a partial refund", async () => {
    // $200 order refunded by $50 is $150 of revenue — the owner's recorded
    // decision, and what every other surface reports for the same order.
    state.orders = [order({ amount_paid: 200, refund_amount: 50, payment_status: "partially_refunded" })];
    const row = await only();
    expect(row.totalSpent).toBe(150);
    expect(row.orderCount).toBe(1);
  });

  it("counts a FULLY refunded order as zero spend, but still as an order", async () => {
    state.orders = [order({ amount_paid: 200, refund_amount: 200, payment_status: "refunded" })];
    const row = await only();
    expect(row.totalSpent).toBe(0);
    expect(row.orderCount).toBe(1);
  });

  it("lets an over-refund reduce lifetime spend, because it really did", async () => {
    // A chargeback on top of a partial can record more back than was collected.
    //
    // This used to assert 80 — the over-refunded order clamped to 0 and left
    // the other order untouched — on the reasoning that "a customer cannot have
    // spent less than nothing". But the $50 handed back beyond what was
    // collected is real money that left the business through this customer, and
    // netOrderRevenue is now signed everywhere (see revenue-clamp-agreement
    // .test.ts) precisely so no surface floors a loss to zero. Lifetime value is
    // net cash from the customer: 100 - 150 + 80 = 30.
    state.orders = [
      order({ order_id: "a", amount_paid: 100, refund_amount: 150, payment_status: "refunded" }),
      order({ order_id: "b", amount_paid: 80, refund_amount: 0, payment_status: "paid" }),
    ];
    const row = await only();
    expect(row.totalSpent).toBe(30);
    expect(row.orderCount).toBe(2);
  });

  it("still ignores an order that was never paid", async () => {
    state.orders = [
      order({ amount_paid: 200, payment_status: "paid" }),
      order({ amount_paid: 999, payment_status: "pending_payment" }),
    ];
    const row = await only();
    expect(row.totalSpent).toBe(200);
  });
});
