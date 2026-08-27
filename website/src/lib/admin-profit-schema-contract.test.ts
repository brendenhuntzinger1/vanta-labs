import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PROFIT READ MUST ASK THE DATABASE FOR COLUMNS THAT EXIST, AND MUST
// ACTUALLY USE THE ONES IT ASKS FOR.
//
// Two defects of the same shape got all the way to a deploy-blocking review,
// and neither could be seen by any test in this repo:
//
//   1. `commissionByOrderId` selected `commissions.payment_status`. That column
//      does not exist. `payment_status` belongs to the SIBLING ledger,
//      referral_orders; the commissions mirror calls it `status`, which is what
//      every writer writes (payment-webhook.ts:857,890,1049 and
//      partner-portal.ts:436,1964,2099). While the read's error was swallowed
//      the effect was a silent zero commission on every order; once it began to
//      throw, the same typo 42703s the /admin dashboard, the order profit
//      panel, the CSV export, the push notification and
//      recordActualShippingCost.
//
//   2. Deleting `store_credit_redeemed_cents, points_redeemed` from
//      ORDER_FIELDS reverts the whole store-credit-as-contra-revenue fix in
//      production — the engine simply never sees the redemption.
//
// WHY NO EXISTING TEST COULD TELL. Every Supabase double in the suite ignores
// the select list: it hands back a fully populated row object no matter what
// was asked for, and it never refuses an unknown column. So the select string
// — the one part of these reads that talks to the real schema — was pure
// decoration to the test suite.
//
// The double below is the narrow fix for that:
//
//   * it PROJECTS. `.select("a, b")` returns rows with exactly `a` and `b`, the
//     way PostgREST does. A column dropped from the select list is therefore
//     `undefined` downstream, exactly as in production.
//   * it REFUSES an unknown column on `commissions`, with the real PostgREST
//     42703 envelope. The whitelist is the column set read back from live
//     production Postgres:
//       id, partner_id, order_id, referral_code, commission_percent,
//       commission_amount, status, created_at, updated_at, tier_name,
//       ineligible_reason, fraud_flag, fraud_reason, customer_discount_percent
//     THERE IS NO payment_status COLUMN ON THIS TABLE.
//
// `orders` is deliberately projected but NOT whitelisted. A whitelist there
// would be a guess about a wide table this reviewer has not enumerated, and a
// wrong guess would fail the suite on a legitimately-added column. Projection
// alone is enough to pin the redemption columns.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Verified against live production Postgres, read-only. Keep in step with it. */
const COMMISSIONS_COLUMNS = new Set([
  "id",
  "partner_id",
  "order_id",
  "referral_code",
  "commission_percent",
  "commission_amount",
  "status",
  "created_at",
  "updated_at",
  "tier_name",
  "ineligible_reason",
  "fraud_flag",
  "fraud_reason",
  "customer_discount_percent",
]);

const state = {
  order: null as Row | null,
  items: [] as Row[],
  commissions: [] as Row[],
  /** Every select list this run handed the `orders` table, in order. */
  orderSelects: [] as string[],
  /** Every select list this run handed the `commissions` table. */
  commissionSelects: [] as string[],
};

function parseColumns(select: string): string[] {
  return select.split(",").map((part) => part.trim()).filter(Boolean);
}

function project(rows: Row[], columns: string[]): Row[] {
  return rows.map((row) => {
    const out: Row = {};
    for (const column of columns) out[column] = row[column];
    return out;
  });
}

vi.mock("server-only", () => ({}));

// The MEASURED production control rows, same as order-profit-store-credit.test.ts.
vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    minProfitPercent: 0,
    minProfitDollars: 0,
    worstCaseUnitCost: 33,
    processingFeePercent: 8,
    processingFeeIncludesTax: true,
    countSalesTaxAsProfit: true,
    shippingCostPerOrder: 6,
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  /** A PostgREST result, thenable and terminable the way supabase-js is. */
  function result(data: unknown, error: unknown = null) {
    const b: Record<string, unknown> = {
      eq() { return b; },
      in() { return b; },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      maybeSingle() {
        const rows = (data ?? []) as Row[];
        return Promise.resolve({ data: error ? null : (rows[0] ?? null), error });
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(resolve({ data: error ? null : data, error }));
      },
    };
    return b;
  }

  const from = (table: string) => ({
    select: (select: string) => {
      const columns = parseColumns(select);

      if (table === "commissions") {
        state.commissionSelects.push(select);
        // PostgREST refuses the whole statement on the FIRST unknown column,
        // with 42703 and the column named. Reproduced verbatim so the code
        // under test sees what it would see in production.
        const unknown = columns.find((column) => !COMMISSIONS_COLUMNS.has(column));
        if (unknown) {
          return result(null, {
            code: "42703",
            message: `column commissions.${unknown} does not exist`,
            details: null,
            hint: null,
          });
        }
        return result(project(state.commissions, columns));
      }

      if (table === "order_items") {
        return result(project(state.items, columns));
      }

      if (table === "orders") {
        state.orderSelects.push(select);
        // The shipping overlay is the only orders read that asks for
        // actual_shipping_cost_cents; everything else is the ORDER_FIELDS read.
        if (columns.includes("actual_shipping_cost_cents")) {
          return result(state.order
            ? [{
              order_id: state.order.order_id,
              actual_shipping_cost_cents: null,
              shipping_cost_source: null,
              profit_finalized: false,
            }]
            : []);
        }
        return result(project(state.order ? [state.order] : [], columns));
      }

      return result([]);
    },
  });

  return { supabaseAdmin: { from } };
});

const { getOrderProfit } = await import("@/lib/admin-profit");

const ORDER_ID = "ord-schema-1";

/**
 * A basket that exercises BOTH redemption columns and every fee column, so a
 * dropped column shows up as a broken invariant rather than as a coincidence.
 *
 *   subtotal $100 · shipping $10 · tax $8 · protection $4 · card surcharge $3
 *   less $20.00 of store credit and 750 points ($7.50)
 *   cash collected: 100 + 10 + 8 + 4 + 3 − 20 − 7.50 = $97.50
 */
function seedOrder(overrides: Row = {}) {
  state.order = {
    order_id: ORDER_ID,
    order_number: "VL-SCHEMA",
    order_type: "product",
    subtotal: 100,
    discount_amount: 0,
    shipping_amount: 10,
    handling_fee: 0,
    tax_amount: 8,
    refund_amount: 0,
    amount_paid: 97.5,
    payment_method: "card",
    payment_status: "paid",
    paid_at: "2026-08-20T00:00:00.000Z",
    created_at: "2026-08-20T00:00:00.000Z",
    shipping_protection_fee: 4,
    card_processing_fee: 3,
    store_credit_redeemed_cents: 2000,
    points_redeemed: 750,
    ...overrides,
  };
  state.items = [{ order_id: ORDER_ID, quantity: 2, unit_cost_cents: 1200 }];
}

/** A mirror row exactly as ensureCommissionRecord writes it. */
function seedCommission(status: string, amount = 15) {
  state.commissions = [{
    id: "c-1",
    partner_id: "11111111-1111-1111-1111-111111111111",
    order_id: ORDER_ID,
    referral_code: "AMB15",
    commission_percent: 15,
    commission_amount: amount,
    status,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    tier_name: "base",
    ineligible_reason: null,
    fraud_flag: false,
    fraud_reason: null,
    customer_discount_percent: 10,
  }];
}

beforeEach(() => {
  state.order = null;
  state.items = [];
  state.commissions = [];
  state.orderSelects = [];
  state.commissionSelects = [];
});

describe("the double models PostgREST the way production does", () => {
  it("refuses commissions.payment_status with 42703, and accepts commissions.status", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    seedCommission("pending");

    const bad = await supabaseAdmin.from("commissions").select("order_id, payment_status").in("order_id", [ORDER_ID]);
    expect(bad.error).toMatchObject({ code: "42703" });
    expect(String((bad.error as { message: string }).message)).toContain("commissions.payment_status");

    const good = await supabaseAdmin.from("commissions").select("order_id, status").in("order_id", [ORDER_ID]);
    expect(good.error).toBeNull();
    expect(good.data).toEqual([{ order_id: ORDER_ID, status: "pending" }]);
  });

  it("projects: a column not named in the select list comes back undefined", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    seedOrder();
    const { data } = await supabaseAdmin.from("orders").select("order_id, amount_paid").eq("order_id", ORDER_ID);
    expect(data).toEqual([{ order_id: ORDER_ID, amount_paid: 97.5 }]);
    expect((data as Row[])[0]).not.toHaveProperty("points_redeemed");
  });
});

describe("the commission mirror read is pinned to the real column", () => {
  it("reads a pending commission and subtracts it from profit", async () => {
    seedOrder();
    seedCommission("pending", 15);
    // Before the fix this threw PostgREST 42703 — the /admin 500 the review
    // blocked the merge over.
    const withCommission = await getOrderProfit(ORDER_ID);
    expect(withCommission?.commission).toBe(15);

    state.commissions = [];
    const without = await getOrderProfit(ORDER_ID);
    expect(without?.commission).toBe(0);
    // The commission is a real deduction, not a decorative field.
    expect(without!.profit - withCommission!.profit).toBeCloseTo(15, 2);
  });

  it("never names a column commissions does not have", async () => {
    seedOrder();
    seedCommission("pending");
    await getOrderProfit(ORDER_ID);
    expect(state.commissionSelects.length).toBeGreaterThan(0);
    for (const select of state.commissionSelects) {
      for (const column of parseColumns(select)) {
        expect(COMMISSIONS_COLUMNS.has(column)).toBe(true);
      }
    }
  });

  it.each([
    ["pending", true],
    ["approved_for_payout", true],
    ["paid", true],
    ["reversed", false],
    ["voided", false],
    ["manual_review", false],
  ])("status %s is %s for the purposes of reducing profit", async (status, earned) => {
    // EVERY value in this table comes from one of four writers:
    // ensureCommissionRecord ('pending'), autoApproveEligibleCommissions
    // ('approved_for_payout'), markCommissionsPaid ('paid') /
    // reversePayout ('approved_for_payout'), and updateCommissionOnRefund
    // (getCommissionStateForRefund -> 'reversed' | 'manual_review'). 'voided' is
    // in EXCLUDED_COMMISSION_STATUSES as a legacy value. A clawed-back
    // commission must NOT keep reducing the owner's reported profit.
    seedOrder();
    seedCommission(status as string, 15);
    const profit = await getOrderProfit(ORDER_ID);
    expect(profit?.commission).toBe(earned ? 15 : 0);
  });
});

describe("the redemption columns are pinned to the select list", () => {
  it("ORDER_FIELDS asks for both redemption columns", async () => {
    seedOrder();
    await getOrderProfit(ORDER_ID);
    const fieldReads = state.orderSelects.filter((s) => s.includes("amount_paid"));
    expect(fieldReads.length).toBeGreaterThan(0);
    for (const select of fieldReads) {
      expect(select).toContain("store_credit_redeemed_cents");
      expect(select).toContain("points_redeemed");
    }
  });

  it("and gross revenue ties to the cash collected because of them", async () => {
    seedOrder();
    const profit = await getOrderProfit(ORDER_ID);
    // THE INVARIANT. Tax is counted as profit in the live control rows, so
    // gross revenue is the whole of amount_paid. Drop either redemption column
    // from ORDER_FIELDS and this reports $125.00 against $97.50 of cash.
    expect(profit?.grossRevenue).toBeCloseTo(97.5, 2);
    expect(profit?.creditRedeemed).toBeCloseTo(27.5, 2);
  });

  it("holds when the order carries a handling fee", async () => {
    // `orders.handling_fee` is a term of the charged total on the customer's
    // invoice, the confirmation page, the account order list and
    // reconciliation-math.expectedOrderTotal — but it was missing from
    // ORDER_FIELDS, so the first order to carry one would have reported
    // `amount_paid 105` against `grossRevenue 100`. Every writer sets it to 0
    // today, which is exactly why this needs a test rather than an incident.
    seedOrder({
      handling_fee: 5,
      store_credit_redeemed_cents: 0,
      points_redeemed: 0,
      amount_paid: 130,
    });
    const profit = await getOrderProfit(ORDER_ID);
    expect(profit?.grossRevenue).toBeCloseTo(130, 2);
    // And it lands in the customer-paid "protection & fees" line, not nowhere.
    expect(profit?.additionalRevenue).toBeCloseTo(12, 2);
  });

  it("holds with only store credit, and with only points", async () => {
    seedOrder({ points_redeemed: 0, amount_paid: 105 });
    expect((await getOrderProfit(ORDER_ID))?.grossRevenue).toBeCloseTo(105, 2);

    seedOrder({ store_credit_redeemed_cents: 0, amount_paid: 117.5 });
    expect((await getOrderProfit(ORDER_ID))?.grossRevenue).toBeCloseTo(117.5, 2);
  });
});
