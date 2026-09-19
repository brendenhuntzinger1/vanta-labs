import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN ORDER SHIPPED WITHOUT BUYING A LABEL MUST NOT REPORT AS A FREE SHIPMENT.
//
// THE PRODUCTION CASE THIS COMES FROM. VL-E8F4D52F (2026-08-02, the store's
// first order) is `fulfillment_status = 'shipped'` with a tracking number, and
// with NO shippo_transaction_id, NO label_purchased_at and NO shipped_at. It
// was shipped by hand and the carrier's tracking number pasted in.
//
// That is not a bug in itself — it is a legitimate thing an operator does. But
// `actual_shipping_cost_cents` is written by recordActualShippingCost, which
// only ever runs off a label PURCHASE. No purchase, no figure, ever: the
// column stays NULL for the life of the order and no sweep can repair it,
// because there is no Shippo transaction to ask about.
//
// So the overlay in admin-profit.ts has to decide what a NULL means, and the
// decision it makes is the only thing standing between that order and a margin
// report that shows it costing nothing to post:
//
//     const hasActual = overlay?.actualShippingCostCents != null;
//     const shippingCost = isMembership ? 0
//       : hasActual ? actual / 100
//       : Math.max(0, config.shippingCostPerOrder);
//
// WHY THIS NEEDS ITS OWN TEST. Nothing pinned that fallback. order-profit.test
// covers the pure function's handling of an estimate it is HANDED;
// admin-profit-schema-contract.test even builds an overlay with
// `actual_shipping_cost_cents: null` — and then never asserts what shipping
// cost comes out of it. Rewrite the three lines above as the tidier-looking
// `(overlay?.actualShippingCostCents ?? 0) / 100` and every hand-shipped order
// silently books full margin on a parcel that really cost $5.48–$11.50 to
// send. The whole suite stays green.
//
// Measured against production on 2026-09-19: 16 shipped orders, 15 of them
// label-bought and all 15 carrying an actual cost. One exception, this class.
// ---------------------------------------------------------------------------

const SHIPPING_ESTIMATE_DOLLARS = 6;

type Overlay = { actual_shipping_cost_cents: number | null; shipping_cost_source: string | null; profit_finalized: boolean };

/** What the overlay read returns for the order under test. */
const overlay: { current: Overlay } = {
  current: { actual_shipping_cost_cents: null, shipping_cost_source: null, profit_finalized: false },
};

const ORDER = {
  order_id: "order-hand-shipped",
  order_number: "VL-HANDSHIP",
  order_type: "product",
  payment_status: "paid",
  paid_at: "2026-08-02T03:10:10.572Z",
  created_at: "2026-08-02T03:10:10.572Z",
  amount_paid: 76.04,
  subtotal: 69.98,
  shipping_amount: 0,
  tax_amount: 0,
  handling_fee: 0,
  shipping_protection_fee: 0,
  discount_amount: 0,
  bulk_discount_amount: 0,
  refund_amount: 0,
  card_processing_fee: 0,
  store_credit_redeemed_cents: 0,
  points_redeemed: 0,
  ambassador_credit_redeemed_cents: 0,
  referral_code: null,
  customer_email: "handship@example.test",
};

vi.mock("@/lib/admin-control", () => ({
  getProfitSettings: async () => ({
    minProfitPercent: 0,
    minProfitDollars: 0,
    worstCaseUnitCost: 33,
    processingFeePercent: 0,
    processingFeeIncludesTax: false,
    countSalesTaxAsProfit: true,
    shippingCostPerOrder: SHIPPING_ESTIMATE_DOLLARS,
  }),
  getCardProcessingFeeConfig: async () => ({ percent: 0, enabled: false }),
}));

vi.mock("@/lib/supabase-server", () => {
  function result(data: unknown) {
    const b: Record<string, unknown> = {
      eq() { return b; }, in() { return b; }, order() { return b; },
      range() { return b; }, limit() { return b; }, not() { return b; }, is() { return b; },
      maybeSingle() { return Promise.resolve({ data: (data as unknown[])?.[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: (data as unknown[])?.[0] ?? null, error: null }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data, error: null })); },
    };
    return b;
  }
  const from = (table: string) => ({
    select: (select: string) => {
      if (table === "orders") {
        // The overlay read is the only orders read asking for the actual cost.
        if (select.includes("actual_shipping_cost_cents")) {
          return result([{ order_id: ORDER.order_id, ...overlay.current }]);
        }
        return result([ORDER]);
      }
      if (table === "order_items") {
        return result([{ order_id: ORDER.order_id, product_id: "p1", quantity: 1, unit_price: 69.98, unit_cost_cents: 365 }]);
      }
      return result([]);
    },
  });
  return { supabaseAdmin: { from } };
});

const { getOrderProfit } = await import("@/lib/admin-profit");

function shippingExpense(profit: Awaited<ReturnType<typeof getOrderProfit>>) {
  return profit?.expenses?.find((e: { key: string }) => e.key === "shipping_cost") ?? null;
}

describe("an order shipped without a purchased label", () => {
  it("is costed at the configured estimate, NOT at zero", async () => {
    overlay.current = { actual_shipping_cost_cents: null, shipping_cost_source: null, profit_finalized: false };
    const profit = await getOrderProfit(ORDER.order_id);
    const shipping = shippingExpense(profit);
    expect(shipping, "the profit report must carry a shipping expense line").not.toBeNull();
    expect(
      Number(shipping?.amount ?? 0),
      "a missing label cost became a free shipment — VL-E8F4D52F's class of order now books full margin on a real parcel",
    ).toBeCloseTo(SHIPPING_ESTIMATE_DOLLARS, 2);
    expect(Number(shipping?.amount ?? 0)).toBeGreaterThan(0);
  });

  it("is labelled an estimate, so nobody reads it as a settled figure", async () => {
    overlay.current = { actual_shipping_cost_cents: null, shipping_cost_source: null, profit_finalized: false };
    const profit = await getOrderProfit(ORDER.order_id);
    expect(profit?.profitStatus).toBe("estimated");
    expect(String(shippingExpense(profit)?.label ?? "")).toMatch(/estimated/i);
  });

  it("switches to the real figure the moment a label IS bought", async () => {
    // The control: the same order with a Shippo-reconciled cost must use it.
    // Without this, a test that only ever sees NULL would pass against code
    // that ignored the actual cost entirely.
    overlay.current = { actual_shipping_cost_cents: 954, shipping_cost_source: "shippo", profit_finalized: true };
    const profit = await getOrderProfit(ORDER.order_id);
    expect(Number(shippingExpense(profit)?.amount ?? 0)).toBeCloseTo(9.54, 2);
    expect(String(shippingExpense(profit)?.label ?? "")).not.toMatch(/estimated/i);
  });

  it("never treats a zero actual cost as 'no figure' and silently re-estimates", async () => {
    // 0 IS A REAL ANSWER — a free label, a returns credit, a parcel a partner
    // posted. `hasActual` is `!= null` precisely so a legitimate zero is not
    // swallowed by a `??` or a falsy check and quietly replaced with the $6
    // guess, which would invent a cost the store never paid.
    //
    // A zero expense is not RENDERED as a line (there is nothing to show), so
    // the property is asserted as "absent or zero, and never the estimate"
    // rather than by the presence of a row.
    overlay.current = { actual_shipping_cost_cents: 0, shipping_cost_source: "shippo", profit_finalized: true };
    const profit = await getOrderProfit(ORDER.order_id);
    const amount = Number(shippingExpense(profit)?.amount ?? 0);
    expect(amount).toBe(0);
    expect(
      amount,
      "a real $0 label cost was replaced by the configured estimate",
    ).not.toBeCloseTo(SHIPPING_ESTIMATE_DOLLARS, 2);
  });
});
