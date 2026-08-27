import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// "REVENUE RECOVERED" IS A REVENUE NUMBER, SO IT USES THE REVENUE DEFINITION.
//
// THE DECISION, and it is a decision rather than an oversight to fix. This tile
// sums the value of orders that closed an abandoned cart, and it summed GROSS
// `amount_paid` with NO refund subtraction and NO status filter at all. Two
// separate problems hid in that one line:
//
//   * no status filter — a cart marked recovered by an order that was never
//     paid (pending, failed, canceled) contributed its full cart value. That is
//     not gross revenue, it is money that never existed, and no convention
//     defends it.
//
//   * gross of refunds — defensible as ATTRIBUTION: the email did bring the
//     customer back, and a return three weeks later is a different event.
//
// The gross reading is rejected here, deliberately. The figure is rendered on
// /admin/cart-recovery in a tile labelled "Revenue Recovered", beside "Potential
// Lost Revenue", and it is read to decide whether recovery emails pay for
// themselves — an economic question that a refunded order answers with zero.
// ledger.ts exists so "revenue" means one thing everywhere, and a second
// definition living behind a money tile is exactly what it forbids.
//
// ATTRIBUTION IS NOT LOST: `totalRecovered` still counts every cart the emails
// closed, refunded or not. The count answers "did the campaign work"; the money
// answers "what did the store keep". Two questions, two numbers, neither
// pretending to be the other.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: { abandoned_carts: Row[]; orders: Row[]; abandoned_cart_emails: Row[]; coupons: Row[] } = {
  abandoned_carts: [],
  orders: [],
  abandoned_cart_emails: [],
  coupons: [],
};

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const rows = (db as unknown as Record<string, Row[]>)[table];
    if (!Array.isArray(rows)) throw new Error(`unexpected table in test: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const settle = () => ({ data: rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row })), error: null });
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push((row) => String(row[col] ?? "") === String(value)); return b; },
      neq(col: string, value: unknown) { filters.push((row) => String(row[col] ?? "") !== String(value)); return b; },
      in(col: string, values: unknown[]) {
        const set = new Set(values.map(String));
        filters.push((row) => set.has(String(row[col])));
        return b;
      },
      order() { return b; },
      limit() { return b; },
      then(resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }
  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

const { getCartRecoveryStats } = await import("@/lib/admin-cart-recovery");

/** One cart, recovered by one order with the given money and status. */
function recoveredBy(id: string, order: Row) {
  db.abandoned_carts.push({
    id, status: "recovered", cart_value_cents: 20000,
    first_seen_at: "2026-08-20T00:00:00.000Z", recovered_order_id: `ord-${id}`,
  });
  db.orders.push({ order_id: `ord-${id}`, order_type: "product", ...order });
}

/** The ledger's own answer for the seeded orders, derived rather than typed. */
function ledgerRevenueCents() {
  return Math.round(
    db.orders
      .filter((row) => isRevenueOrderStatus(String(row.payment_status)) && isSaleOrder(String(row.order_type)))
      .reduce((sum, row) => sum + netOrderRevenue(row as { amount_paid?: number; refund_amount?: number }), 0) * 100,
  );
}

beforeEach(() => {
  db.abandoned_carts = [];
  db.orders = [];
  db.abandoned_cart_emails = [];
  db.coupons = [];
});

describe("recovered revenue", () => {
  it("counts what a recovered order actually collected", async () => {
    recoveredBy("a", { payment_status: "paid", amount_paid: 200, refund_amount: 0 });
    const stats = await getCartRecoveryStats();
    expect(stats.revenueRecoveredCents).toBe(20000);
    expect(stats.totalRecovered).toBe(1);
  });

  it("subtracts a refund, because the store did not keep that money", async () => {
    recoveredBy("a", { payment_status: "partially_refunded", amount_paid: 200, refund_amount: 50 });
    const stats = await getCartRecoveryStats();
    expect(stats.revenueRecoveredCents).toBe(15000);
  });

  it("counts a fully refunded recovery as zero revenue — but still as a recovery", async () => {
    recoveredBy("a", { payment_status: "refunded", amount_paid: 200, refund_amount: 200 });
    const stats = await getCartRecoveryStats();
    // The email did its job, and that is what totalRecovered records. The store
    // kept nothing, and that is what the money records.
    expect(stats.revenueRecoveredCents).toBe(0);
    expect(stats.totalRecovered).toBe(1);
  });

  it("ignores an order that never took a payment", async () => {
    // Was 20000: no status filter at all, so a cart 'recovered' by an order
    // that failed at the processor reported its full value as revenue.
    recoveredBy("a", { payment_status: "pending_payment", amount_paid: 200, refund_amount: 0 });
    recoveredBy("b", { payment_status: "canceled", amount_paid: 200, refund_amount: 0 });
    const stats = await getCartRecoveryStats();
    expect(stats.revenueRecoveredCents).toBe(0);
  });

  it("ignores a replacement, which is a reship the store paid for", async () => {
    recoveredBy("a", { payment_status: "paid", order_type: "replacement", amount_paid: 15, refund_amount: 0 });
    const stats = await getCartRecoveryStats();
    expect(stats.revenueRecoveredCents).toBe(0);
  });

  it("agrees with ledger.netOrderRevenue across the whole basket", async () => {
    // The property, not five examples: whatever the basket, this tile and the
    // canonical revenue definition land on the same number.
    recoveredBy("paid", { payment_status: "paid", amount_paid: 200, refund_amount: 0 });
    recoveredBy("partial", { payment_status: "partially_refunded", amount_paid: 200, refund_amount: 50 });
    recoveredBy("full", { payment_status: "refunded", amount_paid: 200, refund_amount: 200 });
    recoveredBy("never-paid", { payment_status: "pending_payment", amount_paid: 200, refund_amount: 0 });
    recoveredBy("reship", { payment_status: "paid", order_type: "replacement", amount_paid: 15, refund_amount: 0 });
    recoveredBy("over", { payment_status: "partially_refunded", amount_paid: 100, refund_amount: 150 });

    const stats = await getCartRecoveryStats();

    expect(ledgerRevenueCents()).toBe(30000); // 200 + 150 − 50, in cents
    expect(stats.revenueRecoveredCents).toBe(ledgerRevenueCents());
    // Every cart is still counted as recovered, whatever became of the money.
    expect(stats.totalRecovered).toBe(6);
  });
});
