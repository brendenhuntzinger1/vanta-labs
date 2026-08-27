import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// STORE CREDIT AND LOYALTY POINTS ARE NOT REVENUE.
//
// Both are tender the STORE issues: store credit is a monthly membership perk,
// points are earned on earlier orders. Neither is money a customer ever paid
// in. `profitForOrder` derived merchandise revenue as `subtotal −
// discount_amount` and never read either redemption column, and it papered over
// the gap by swapping `additionalRevenue` for a residual
// (`amount_paid − merch − shipping − tax`, clamped at ≥ 0) on any redeeming
// order. That residual expands to `cardFee + protection − storeCredit − points`,
// which conflates real protection revenue the customer DID pay with non-cash
// tender they did NOT, and then clamps the mixture at zero.
//
// Measured against the live control rows (fee 8% incl. tax, tax counted as
// profit, $6 shipping estimate) on a $100 / $10 shipping / $4 protection /
// $3 surcharge order that shipped for $7 with $24 of COGS:
//
//   redemption            cash in    revenue reported (was)   overstated by
//   none                  $117.00    $117.00                  —
//   $20 store credit       $97.00    $110.00                  $13.00
//   500 points ($5)       $112.00    $112.00 (but "protection & fees" $2 of $7)
//   $20 credit + $5 points $92.00    $110.00                  $18.00
//   $20 credit, refunded   $0 net     $13.00                  $13.00
//
// The overstatement is `redeemed − (protection + surcharge)`, so it is NOT
// always the redeemed amount and it is NOT always non-zero — which is exactly
// why it needs a test rather than an eyeball. THE INVARIANT THAT PINS IT is
// stated once, at the bottom of this file, and holds on every order:
//
//     grossRevenue === amount_paid           (tax counted as profit)
//     grossRevenue === amount_paid − tax     (tax as a pass-through)
//
// the same cash definition ledger.netOrderRevenue uses, so the profit report
// and the revenue/analytics pages describe the same dollars.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const state = {
  order: null as Row | null,
  items: [] as Array<{ order_id: string; quantity: number; unit_cost_cents: number | null }>,
  commissions: [] as Array<{ order_id: string; commission_amount: number; payment_status: string }>,
  overlayCents: null as number | null,
  countTaxAsProfit: true,
};

vi.mock("server-only", () => ({}));

// The MEASURED production control rows: processing_fee_percent blank (coded
// default 8), processing_fee_includes_tax true, count_sales_tax_as_profit true,
// shipping_cost_estimate blank ($6), worst_case_unit_cost blank ($33).
vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    minProfitPercent: 0,
    minProfitDollars: 0,
    worstCaseUnitCost: 33,
    processingFeePercent: 8,
    processingFeeIncludesTax: true,
    countSalesTaxAsProfit: state.countTaxAsProfit,
    shippingCostPerOrder: 6,
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  function envelope(data: unknown) {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data, error: null }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data, error: null })); },
    };
    return b;
  }

  const from = (table: string) => {
    if (table === "order_items") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            in() { return b; },
            order() { return b; },
            range(start: number, end: number) { return envelope(state.items.slice(start, end + 1)); },
          };
          return b;
        },
      };
    }
    if (table === "commissions") {
      return { select: () => ({ in: () => envelope(state.commissions) }) };
    }
    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            maybeSingle() { return Promise.resolve({ data: state.order, error: null }); },
            // The only orders select that uses .in(...) is the shipping overlay.
            in() {
              return envelope(
                state.order
                  ? [{
                      order_id: state.order.order_id,
                      actual_shipping_cost_cents: state.overlayCents,
                      shipping_cost_source: state.overlayCents == null ? null : "shippo",
                      profit_finalized: state.overlayCents != null,
                    }]
                  : [],
              );
            },
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
const { computeOrderProfit } = await import("@/lib/order-profit");

interface Scenario {
  subtotal: number;
  discount?: number;
  shipping?: number;
  tax?: number;
  protection?: number;
  cardFee?: number;
  /** integer CENTS, as the column stores it */
  storeCreditCents?: number;
  /** POINTS, as the column stores it — 100 points = $1 */
  pointsRedeemed?: number;
  refund?: number;
  commission?: number;
  orderType?: string;
  paymentStatus?: string;
  unitCostCents?: number | null;
  quantity?: number;
  actualShipCents?: number | null;
  /** orders.amount_paid, stated explicitly so the arithmetic stays visible. */
  amountPaid: number;
}

/**
 * The canonical basket, so every difference below is attributable to the two
 * redemption columns and nothing else:
 *   subtotal $100 · shipping charged $10 · protection $4 · card surcharge $3
 *   2 units at unit_cost_cents 1200 → COGS $24 · exact label cost $7
 */
const BASE = {
  subtotal: 100,
  shipping: 10,
  protection: 4,
  cardFee: 3,
  unitCostCents: 1200,
  quantity: 2,
  actualShipCents: 700,
};

async function profitFor(s: Scenario) {
  state.order = {
    order_id: "ord-1",
    order_number: "VL-TEST",
    order_type: s.orderType ?? "product",
    subtotal: s.subtotal,
    discount_amount: s.discount ?? 0,
    shipping_amount: s.shipping ?? 0,
    tax_amount: s.tax ?? 0,
    refund_amount: s.refund ?? 0,
    amount_paid: s.amountPaid,
    payment_method: "card",
    payment_status: s.paymentStatus ?? "paid",
    paid_at: "2026-08-20T00:00:00.000Z",
    created_at: "2026-08-20T00:00:00.000Z",
    shipping_protection_fee: s.protection ?? 0,
    card_processing_fee: s.cardFee ?? 0,
    store_credit_redeemed_cents: s.storeCreditCents ?? 0,
    points_redeemed: s.pointsRedeemed ?? 0,
  };
  state.items = s.unitCostCents === undefined
    ? []
    : [{ order_id: "ord-1", quantity: s.quantity ?? 1, unit_cost_cents: s.unitCostCents }];
  state.commissions = s.commission
    ? [{ order_id: "ord-1", commission_amount: s.commission, payment_status: "pending" }]
    : [];
  state.overlayCents = s.actualShipCents ?? null;

  const result = await getOrderProfit("ord-1");
  if (!result) throw new Error("getOrderProfit returned null for a seeded order");
  return result;
}

beforeEach(() => {
  state.order = null;
  state.items = [];
  state.commissions = [];
  state.overlayCents = null;
  state.countTaxAsProfit = true;
});

describe("the engine treats redemption as contra-revenue, not as an expense", () => {
  it("deducts it from gross revenue and reports it as its own term", () => {
    const r = computeOrderProfit({
      netMerchandiseRevenue: 100,
      shippingRevenue: 10,
      additionalRevenue: 7,
      creditRedeemed: 20,
      shippingCost: 7,
      lines: [{ unitCostCents: 1200, quantity: 2 }],
      commission: 0,
      processingFee: 7.76,
      refund: 0,
    });
    expect(r.grossRevenue).toBe(97);
    expect(r.creditRedeemed).toBe(20);
    // NOT an expense line: expenses are what the store PAID OUT, and no dollar
    // left the building for a credit the store issued in the first place.
    expect(r.expenses.map((e) => e.key)).toEqual(["cogs", "shipping_cost", "processing_fee"]);
    expect(r.totalExpenses).toBe(38.76);
    expect(r.profit).toBe(58.24);
  });

  it("an order that EARNS points accrues nothing — the cost lands at redemption", () => {
    // Earning and redeeming must not BOTH reduce profit, or the same dollar is
    // counted twice. Cash basis at both ends: earn is free, redemption is not.
    const earn = computeOrderProfit({
      netMerchandiseRevenue: 100,
      shippingRevenue: 0,
      shippingCost: 0,
      lines: [],
      commission: 0,
      processingFee: 0,
      refund: 0,
    });
    expect(earn.creditRedeemed).toBe(0);
    expect(earn.profit).toBe(100);
  });
});

describe("store credit / points on a real order row", () => {
  it("no redemption: revenue is what was charged", async () => {
    const p = await profitFor({ ...BASE, amountPaid: 117 });
    expect(p.grossRevenue).toBe(117);
    expect(p.creditRedeemed).toBe(0);
    expect(p.additionalRevenue).toBe(7);
    expect(p.processingFee).toBe(9.36); // 8% of $117
    expect(p.profit).toBe(76.64);       // 117 − 24 − 7 − 9.36
  });

  it("$20 of store credit: $97 collected, $97 of revenue", async () => {
    const p = await profitFor({ ...BASE, storeCreditCents: 2000, amountPaid: 97 });
    expect(p.creditRedeemed).toBe(20);
    expect(p.grossRevenue).toBe(97);    // was $110
    expect(p.additionalRevenue).toBe(7);
    expect(p.profit).toBe(58.24);       // 97 − 24 − 7 − 7.76; was $71.24
  });

  it("500 points is $5, through the shared redemption rate — not a local /100", async () => {
    const p = await profitFor({ ...BASE, pointsRedeemed: 500, amountPaid: 112 });
    expect(p.creditRedeemed).toBe(5);
    expect(p.grossRevenue).toBe(112);
    // THE PART THE OLD RESIDUAL GOT WRONG EVEN WHERE THE TOTAL HAPPENED TO TIE:
    // the customer paid $7 of protection and surcharge, and the residual
    // reported $2 of it because it had absorbed the $5 redemption.
    expect(p.additionalRevenue).toBe(7);
    expect(p.profit).toBe(72.04);
  });

  it("store credit and points together", async () => {
    const p = await profitFor({ ...BASE, storeCreditCents: 2000, pointsRedeemed: 500, amountPaid: 92 });
    expect(p.creditRedeemed).toBe(25);
    expect(p.grossRevenue).toBe(92);    // was $110
    expect(p.profit).toBe(53.64);       // was $71.64
  });

  it("a coupon and points are different things and both apply", async () => {
    const p = await profitFor({ ...BASE, discount: 15, pointsRedeemed: 500, amountPaid: 97 });
    expect(p.merchandiseRevenue).toBe(85); // the coupon is a price reduction
    expect(p.creditRedeemed).toBe(5);      // the points are tender
    expect(p.grossRevenue).toBe(97);
    expect(p.profit).toBe(58.24);
  });

  it("a referral commission is still charged on the discounted merchandise", async () => {
    // quote-order refuses to apply credit or points alongside a referral code,
    // so this row shape is not reachable from checkout. It is asserted anyway:
    // the report must be right about a row it is handed, not only about the
    // rows checkout currently produces.
    const p = await profitFor({ ...BASE, discount: 10, commission: 9, storeCreditCents: 2000, amountPaid: 87 });
    expect(p.commission).toBe(9);
    expect(p.grossRevenue).toBe(87);
    expect(p.profit).toBe(40.04);
  });

  it("a full refund of a redeeming order nets to zero revenue, not to the redemption", async () => {
    const p = await profitFor({
      ...BASE, storeCreditCents: 2000, refund: 97, paymentStatus: "refunded", amountPaid: 97,
    });
    expect(p.grossRevenue).toBe(97);
    expect(p.revenue).toBe(0);       // was $13 — the unbooked credit
    expect(p.profit).toBe(-38.76);   // the costs really were spent; was −$25.76
  });

  it("a partial refund of a redeeming order", async () => {
    const p = await profitFor({
      ...BASE, storeCreditCents: 2000, refund: 48.5, paymentStatus: "partially_refunded", amountPaid: 97,
    });
    expect(p.revenue).toBe(48.5);
    expect(p.profit).toBe(9.74);
  });

  it("a replacement has no revenue, no fee, and real cost", async () => {
    const p = await profitFor({
      subtotal: 0, orderType: "replacement", unitCostCents: 1200, quantity: 2, actualShipCents: 700, amountPaid: 0,
    });
    expect(p.grossRevenue).toBe(0);
    expect(p.creditRedeemed).toBe(0);
    expect(p.processingFee).toBe(0);
    expect(p.profit).toBe(-31);
  });

  it("credit applied against collected tax still reconciles", async () => {
    const p = await profitFor({ ...BASE, tax: 8, storeCreditCents: 2000, amountPaid: 105 });
    expect(p.grossRevenue).toBe(105); // was $118
    expect(p.taxCollected).toBe(8);
    expect(p.profit).toBe(65.6);      // 105 − 24 − 7 − 8.40
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT. Everything above is one instance of it; this is the rule.
// ---------------------------------------------------------------------------
describe("gross revenue equals cash collected, on every order", () => {
  const CASES: Array<[string, Scenario]> = [
    ["plain card order", { ...BASE, amountPaid: 117 }],
    ["store credit", { ...BASE, storeCreditCents: 2000, amountPaid: 97 }],
    ["points", { ...BASE, pointsRedeemed: 500, amountPaid: 112 }],
    ["credit + points", { ...BASE, storeCreditCents: 2000, pointsRedeemed: 500, amountPaid: 92 }],
    ["coupon + points", { ...BASE, discount: 15, pointsRedeemed: 500, amountPaid: 97 }],
    ["referral + credit", { ...BASE, discount: 10, commission: 9, storeCreditCents: 2000, amountPaid: 87 }],
    ["with sales tax", { ...BASE, tax: 8, storeCreditCents: 2000, amountPaid: 105 }],
    ["free shipping, no add-ons", { subtotal: 60, unitCostCents: 900, quantity: 1, pointsRedeemed: 1200, amountPaid: 48 }],
    ["odd points count", { ...BASE, pointsRedeemed: 237, amountPaid: 114.63 }],
    ["replacement", { subtotal: 0, orderType: "replacement", unitCostCents: 1200, quantity: 2, amountPaid: 0 }],
  ];

  it.each(CASES)("%s — tax counted as profit: gross === amount_paid", async (_name, scenario) => {
    state.countTaxAsProfit = true;
    const p = await profitFor(scenario);
    expect(p.grossRevenue).toBe(scenario.amountPaid);
  });

  it.each(CASES)("%s — tax as pass-through: gross === amount_paid − tax", async (_name, scenario) => {
    state.countTaxAsProfit = false;
    const p = await profitFor(scenario);
    expect(p.grossRevenue).toBe(Math.round((scenario.amountPaid - (scenario.tax ?? 0)) * 100) / 100);
  });
});
