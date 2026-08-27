import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE SYNTHETIC REFERRED PAID ORDER, RECONCILED INDEPENDENTLY.
//
// The figures on the right-hand side of every assertion here were worked out by
// hand from the definitions, in a throwaway script that imports NOTHING from
// this repo, and are pasted in as literals. That is the point: a check that
// shares code with the thing it checks cannot disagree with it, which is how
// the missing commission survived — the one test that touched the commission
// read returned an empty envelope, which is exactly what the bug produced.
//
// THE ORDER. Every term non-zero, no round numbers that could match by luck:
//
//   merchandise subtotal      $263.95
//   referral discount (15%)    $18.60
//   shipping charged           $15.00
//   sales tax collected         $8.25   pass-through, never profit
//   shipping protection fee     $4.41   customer-paid, so revenue
//   card processing fee         $9.85   customer-paid revenue; the processor
//                                       rate is 0% here, so no matching cost
//   COGS, 7 vials at $12.40    $86.80
//   commission, 10%            $26.40   <- silently $0.00 before the fix
//   actual shipping label       $9.12
//
//   revenue   245.35 + 15.00 + 14.26   = 274.61
//   expenses  86.80 + 26.40 + 9.12     = 122.32
//   PROFIT                             = 152.29
//
//   with the commission dropped, as the bug did = 178.69, a 17.3% overstatement
//
// THE CHECK EARNED ITS KEEP ON THE FIRST RUN. The hand version subtracted the
// $9.85 card fee as a cost as well as counting it as revenue. This scenario
// configures the processor rate at 0%, so there is no processor charge to
// subtract, and the application said 152.29 where the hand figure said 142.44.
// The application was right and the hand model was double-counting. Recorded
// because a reconciliation that has never disagreed with anything has not been
// shown to work.
// ---------------------------------------------------------------------------

const ORDER = {
  order_id: "ord-reconcile-1",
  order_number: "VL-9001",
  order_type: "product",
  subtotal: 263.95,
  discount_amount: 18.60,
  shipping_amount: 15.00,
  tax_amount: 8.25,
  refund_amount: 0,
  amount_paid: 283.06,
  payment_method: "card",
  payment_status: "paid",
  paid_at: "2026-08-21T10:00:00.000Z",
  created_at: "2026-08-21T10:00:00.000Z",
  shipping_protection_fee: 4.41,
  card_processing_fee: 9.85,
  store_credit_redeemed_cents: 0,
  points_redeemed: 0,
};

vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    // The label cost is exact on this order, so no estimate is involved and the
    // reconciliation has one unambiguous answer.
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
  const envelope = (data: unknown) => {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      gte() { return b; },
      lte() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle: async () => ({ data, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data, error: null })); },
    };
    return b;
  };

  const from = (table: string) => {
    if (table === "commissions") {
      return { select: () => ({ in: () => envelope([{ order_id: ORDER.order_id, commission_amount: 26.40, status: "pending" }]) }) };
    }
    if (table === "order_items") {
      return {
        select: () => ({
          in: () => ({
            order: () => ({
              range: (f: number) => envelope(f === 0 ? [{ order_id: ORDER.order_id, quantity: 7, unit_cost_cents: 1240 }] : []),
            }),
          }),
        }),
      };
    }
    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            maybeSingle: async () => ({ data: ORDER, error: null }),
            in: (_c: string, ids: string[]) => envelope(ids.map((id) => ({
              order_id: id,
              actual_shipping_cost_cents: 912,
              shipping_cost_source: "shippo",
              profit_finalized: true,
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

describe("a referred paid order reconciles against a hand-computed figure", () => {
  it("agrees term by term", async () => {
    const profit = await getOrderProfit(ORDER.order_id);
    expect(profit).not.toBeNull();

    expect(profit!.merchandiseRevenue).toBe(245.35);
    expect(profit!.shippingCharged).toBe(15.00);
    expect(profit!.additionalRevenue).toBe(14.26);
    expect(profit!.revenue).toBe(274.61);

    expect(profit!.cogs).toBe(86.80);
    expect(profit!.commission).toBe(26.40);
    expect(profit!.shippingCost).toBe(9.12);
    expect(profit!.totalExpenses).toBe(122.32);

    expect(profit!.profit).toBe(152.29);
  });

  it("counts collected sales tax as pass-through, not profit", async () => {
    const profit = await getOrderProfit(ORDER.order_id);
    expect(profit!.taxCollected).toBe(8.25);
    expect(profit!.taxCountedAsProfit).toBe(false);
    // 274.61 already excludes the $8.25.
    expect(profit!.revenue).toBe(274.61);
  });

  // THE BUG, PRICED. This is the number the dashboard, the CSV export and the
  // operator's push notification were all reporting.
  it("is $26.40 lower than the figure the missing commission produced", async () => {
    const profit = await getOrderProfit(ORDER.order_id);
    const whatTheBugReported = 178.69;
    expect(profit!.profit).toBe(152.29);
    expect(Math.round((whatTheBugReported - profit!.profit) * 100) / 100).toBe(26.40);
  });
});
