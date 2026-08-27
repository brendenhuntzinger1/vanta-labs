import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// DOES THE PROFIT NUMBER SUBTRACT THE COMMISSION IT PAID?
//
// commissionByOrderId asked for `commissions.payment_status`. That column does
// not exist. Every definition of the table in this repo declares `status`
// (affiliate-program-schema.sql, deploy-run-once.sql, partner-system-repair.sql,
// schema-complete-sync.sql), every other reader and writer uses `status`
// (payment-webhook, partner-portal, admin-ambassadors), and the production
// schema was checked directly: `status`, no `payment_status`.
//
// PostgREST answers an unknown column with 42703 and no rows. The call
// destructured `{ data }` alone and never looked at `error`, so the map came
// back empty and every commission silently became $0.00. Profit was overstated
// by the full commission on every referred order, on the dashboard, in the
// orders CSV export, and in the operator's order push notification.
//
// It survived because the one test that touched this read returned an empty
// envelope (admin-profit-at-scale.test.ts), which is exactly what the bug
// produces. A fake that answers everything cannot fail.
//
// So the fake below models the real thing: it knows the production column set
// and answers an unknown column the way PostgREST does. Asking for the wrong
// name fails here for the same reason it fails in production.
// ---------------------------------------------------------------------------

/**
 * The real production column set of `commissions`, read from
 * information_schema on project mlpimwgkwuqpsvsrlpqv.
 */
const COMMISSION_COLUMNS = new Set([
  "id", "partner_id", "order_id", "referral_code", "commission_percent",
  "commission_amount", "status", "created_at", "updated_at", "tier_name",
  "ineligible_reason", "fraud_flag", "fraud_reason", "customer_discount_percent",
]);

interface CommissionRow {
  order_id: string;
  commission_amount: number;
  status: string;
}

const state = {
  commissions: [] as CommissionRow[],
  /** Simulates a transport/permission failure rather than a bad column. */
  commissionsFail: null as null | { code: string; message: string },
  selectedColumns: "" as string,
};

const ORDER = {
  order_id: "ord-referred-1",
  order_number: "VL-1001",
  order_type: "product",
  subtotal: 200,
  discount_amount: 0,
  shipping_amount: 0,
  tax_amount: 0,
  refund_amount: 0,
  amount_paid: 200,
  payment_method: "card",
  payment_status: "paid",
  paid_at: "2026-08-20T12:00:00.000Z",
  created_at: "2026-08-20T12:00:00.000Z",
  shipping_protection_fee: 0,
  card_processing_fee: 0,
  store_credit_redeemed_cents: 0,
  points_redeemed: 0,
};

vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    processingFeePercent: 0,
    defaultShippingCostCents: 0,
    handlingCostCents: 0,
    defaultUnitCostCents: 0,
    countSalesTaxAsProfit: false,
    shippingCostPerOrder: 0,
    worstCaseUnitCost: 0,
    minProfitPercent: 0,
    minProfitDollars: -1e9,
    processingFeeIncludesTax: false,
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  const envelope = (data: unknown, error: unknown = null) => {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      gte() { return b; },
      lte() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle: async () => ({ data, error }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data, error })); },
    };
    return b;
  };

  const from = (table: string) => {
    if (table === "commissions") {
      return {
        select: (columns: string) => {
          state.selectedColumns = columns;
          if (state.commissionsFail) {
            return { in: () => envelope(null, state.commissionsFail) };
          }
          // PostgREST's own behaviour: an unknown column is 42703 and NO rows.
          const unknown = columns.split(",").map((c) => c.trim()).filter((c) => c && !COMMISSION_COLUMNS.has(c));
          if (unknown.length > 0) {
            return {
              in: () => envelope(null, {
                code: "42703",
                message: `column commissions.${unknown[0]} does not exist`,
              }),
            };
          }
          return { in: (_c: string, ids: string[]) => envelope(state.commissions.filter((r) => ids.includes(r.order_id))) };
        },
      };
    }
    if (table === "order_items") {
      return { select: () => ({ in: () => ({ order: () => ({ range: (f: number) => envelope(f === 0 ? [{ order_id: ORDER.order_id, quantity: 1, unit_cost_cents: 5000 }] : []) }) }) }) };
    }
    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            // The single-order read.
            eq() { return b; },
            maybeSingle: async () => ({ data: ORDER, error: null }),
            // The chunked shipping overlay read.
            in: (_c: string, ids: string[]) => envelope(ids.map((id) => ({
              order_id: id, actual_shipping_cost_cents: null, shipping_cost_source: null, profit_finalized: false,
            }))),
            gte() { return b; },
            lte() { return b; },
            order() { return b; },
            range: () => envelope([]),
          };
          return b;
        },
      };
    }
    return { select: () => envelope([]) };
  };
  return { supabaseAdmin: { from } };
});

const { getOrderProfit } = await import("@/lib/admin-profit");

beforeEach(() => {
  state.commissions = [];
  state.commissionsFail = null;
  state.selectedColumns = "";
});

describe("commission is deducted from the profit on a referred order", () => {
  it("subtracts an earned commission", async () => {
    state.commissions = [{ order_id: ORDER.order_id, commission_amount: 30, status: "pending" }];
    const profit = await getOrderProfit(ORDER.order_id);

    // $200 revenue − $50 COGS − $30 commission. The commission has to be
    // ON the result, and it has to have moved the bottom line.
    expect(profit?.commission).toBe(30);
    expect(profit?.profit).toBe(120);
  });

  it("reports zero commission, and a higher profit, when no commission was earned", async () => {
    state.commissions = [];
    const profit = await getOrderProfit(ORDER.order_id);

    expect(profit?.commission).toBe(0);
    expect(profit?.profit).toBe(150);
  });

  // WITHOUT THIS, "always subtract" passes the test above. A clawed-back
  // commission was never paid, so charging the owner for it is the opposite
  // error and just as wrong.
  it.each([
    ["reversed"],
    ["voided"],
    ["manual_review"],
  ])("does not subtract a %s commission the owner never paid", async (status) => {
    state.commissions = [{ order_id: ORDER.order_id, commission_amount: 30, status }];
    const profit = await getOrderProfit(ORDER.order_id);

    expect(profit?.commission).toBe(0);
    expect(profit?.profit).toBe(150);
  });

  it("sums more than one earned commission row on the same order", async () => {
    state.commissions = [
      { order_id: ORDER.order_id, commission_amount: 20, status: "pending" },
      { order_id: ORDER.order_id, commission_amount: 10, status: "approved_for_payout" },
      { order_id: ORDER.order_id, commission_amount: 99, status: "reversed" },
    ];
    const profit = await getOrderProfit(ORDER.order_id);

    expect(profit?.commission).toBe(30);
  });

  it("asks only for columns the table actually has", async () => {
    state.commissions = [{ order_id: ORDER.order_id, commission_amount: 30, status: "pending" }];
    await getOrderProfit(ORDER.order_id);

    const asked = state.selectedColumns.split(",").map((c) => c.trim()).filter(Boolean);
    expect(asked.length).toBeGreaterThan(0);
    for (const column of asked) {
      expect(COMMISSION_COLUMNS.has(column), `commissions has no column "${column}"`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// A READ THAT FAILED MUST NEVER LOOK LIKE A READ THAT FOUND NOTHING.
//
// This is the half that let the column bug live. "No commission rows" and "the
// commission query failed" produced the identical answer — $0.00 — and $0.00 of
// commission is the most flattering possible number. The failure has to be
// louder than the happy path, because it moves the figure in the direction
// nobody questions.
//
// The house pattern for a read whose failure would distort a money figure is
// already in this file: readAllRowsBounded throws
// "<label> failed: <message>". Commission follows it.
// ---------------------------------------------------------------------------
describe("a failed commissions read cannot be mistaken for zero commission", () => {
  it("refuses to report a profit figure when the query errors", async () => {
    state.commissionsFail = { code: "42501", message: "permission denied for table commissions" };

    await expect(getOrderProfit(ORDER.order_id)).rejects.toThrow(/commission/i);
  });

  it("names the underlying failure so it can be diagnosed", async () => {
    state.commissionsFail = { code: "42501", message: "permission denied for table commissions" };

    await expect(getOrderProfit(ORDER.order_id)).rejects.toThrow(/permission denied/i);
  });

  // The original defect, stated as a test: ask for a column that is not there
  // and the read fails. It must not come back as "this order paid no
  // commission".
  it("refuses rather than reporting inflated profit when the column is wrong", async () => {
    state.commissionsFail = { code: "42703", message: "column commissions.payment_status does not exist" };

    await expect(getOrderProfit(ORDER.order_id)).rejects.toThrow(/commission/i);
  });
});
