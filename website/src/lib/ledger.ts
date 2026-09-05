// =====================================================================
// CANONICAL LEDGER PREDICATES — the single source of truth every report,
// dashboard, and aggregation MUST use so no two surfaces ever disagree on what
// "paid", "earned commission", or "revenue" means. Before this module, the
// ambassador summary, admin partner rows, and program stats each filtered
// commissions differently, and revenue was counted gross on some dashboards and
// with different "paid" definitions on others.
// ============================================================================

// A commission row is CLAWED BACK / not earned when it was reversed, voided, or
// is under manual review. Everything else counts toward earned/lifetime totals.
export const EXCLUDED_COMMISSION_STATUSES = new Set(["reversed", "voided", "manual_review"]);

export function isEarnedCommission(paymentStatus: string | null | undefined): boolean {
  return !EXCLUDED_COMMISSION_STATUSES.has(String(paymentStatus ?? "").toLowerCase());
}

// The order payment states that represent CAPTURED money. The state machine only
// writes "paid" today, but the defensive synonyms are accepted everywhere so no
// dashboard silently drops a captured order and all surfaces agree.
export const PAID_ORDER_STATUSES = new Set(["paid", "completed", "succeeded"]);

export function isPaidOrderStatus(status: string | null | undefined): boolean {
  return PAID_ORDER_STATUSES.has(String(status ?? "").toLowerCase());
}

// The order payment states that CONTRIBUTE REVENUE — captured money, plus the
// money RETAINED on an order that was only partly refunded.
//
// Owner's decision, recorded because reports had disagreed about it: a $200
// order refunded by $50 is $150 of revenue. It is still an order, it still
// counts, and what the customer kept paying for is still the store's. Only the
// $50 goes away.
//
// This is deliberately WIDER than PAID_ORDER_STATUSES. A fully refunded order
// is excluded here because netOrderRevenue() would give it 0 anyway, and
// counting it would drag average order value down with a $0 denominator. The
// difference between the two sets is exactly `partially_refunded`.
//
// MIRRORED IN SQL: src/lib/sql/admin-dashboard-rollups.sql. The two are kept in
// step by ledger-sql-parity.test.ts, which fails if either side changes alone.
export const REVENUE_ORDER_STATUSES = new Set([...PAID_ORDER_STATUSES, "partially_refunded"]);

export function isRevenueOrderStatus(status: string | null | undefined): boolean {
  return REVENUE_ORDER_STATUSES.has(String(status ?? "").toLowerCase());
}

// The order payment states where MONEY WAS ACTUALLY CAPTURED — every revenue
// status above, plus a FULLY REFUNDED order (it took the money, then gave it
// back). Everything else — pending_payment, awaiting_verification, canceled,
// payment_failed, payment_rejected — never charged anyone a cent.
//
// THIS IS THE PROFIT REPORT'S SET, and it answers both halves of one question.
//
// A refund returns the revenue. It does not return:
//
//   • the COGS — the vials were picked, packed and posted, and they did not
//     come back
//   • the postage — the label was bought and used
//   • the processor fee — kept on a refunded charge
//
// Revenue surfaces are right to drop a fully refunded order (netOrderRevenue is
// 0, and counting it would divide average order value by a $0 denominator). The
// profit report is not: dropping the ROW drops the COSTS with it, so net profit
// was overstated by exactly what the store lost, and the worse the refund the
// better the dashboard looked (VL-24 / M-02 / REF-05). The engine nets such an
// order's revenue to zero on its own, so including it adds a loss, never
// phantom revenue.
//
// The other half is the mirror image (M-03). `orders.amount_paid` is written
// when the order is CREATED, before anyone has paid, so an order that never
// took payment carries a full basket, a subtotal and a shipping charge. Any
// surface that computes profit from those columns without checking this
// predicate reports revenue, COGS, postage and a processor fee for a sale that
// never happened.
export const CAPTURED_PAYMENT_STATUSES = new Set([...REVENUE_ORDER_STATUSES, "refunded"]);

export function hasCapturedPayment(status: string | null | undefined): boolean {
  return CAPTURED_PAYMENT_STATUSES.has(String(status ?? "").toLowerCase());
}

// The order types that are NOT sales. A `replacement` is an outbound reshipment
// the store paid for itself: payment_status is "paid" and amount_paid is 0, so
// every count that filters on status alone counts it as an order and divides
// revenue by a denominator that includes it — 100 sales plus 3 reships reports
// 103 orders and drags average order value down with three $0 denominators.
//
// A `membership` IS a sale (real money, real revenue). It is excluded from
// FULFILLMENT because nothing ships, which is a different question answered by
// a different filter. Nothing here may be used to drop it from revenue.
export const NON_SALE_ORDER_TYPES = new Set(["replacement"]);

export function isSaleOrder(orderType: string | null | undefined): boolean {
  return !NON_SALE_ORDER_TYPES.has(String(orderType ?? "product").toLowerCase());
}

/**
 * Did the customer BUY PRODUCT with this order? The predicate every
 * behaviour-driven email flow must use before treating an order as a purchase.
 *
 * `isSaleOrder` answers a REVENUE question — a membership charge is real
 * revenue, so it is a sale. It is not a purchase of product: nothing arrives in
 * a box, there is no COA to read, nothing to restock in thirty days, and a
 * monthly renewal is not the customer "coming back". A replacement reship is
 * neither revenue nor a purchase. The post-purchase, replenishment and win-back
 * automations, and the abandoned-cart "recovered" mark, all keyed on
 * payment_status alone and so fired — or silenced — on membership charges and
 * $0 reships (EMAIL-02 / EMAIL-03).
 *
 * `replacement_of` is honoured when the row carries it (a `select *` read); a
 * reship also carries order_type 'replacement', which is the column every list
 * read selects, so the column's presence is never required.
 */
export function isProductPurchaseOrder(order: {
  order_type?: string | null;
  replacement_of?: string | null;
}): boolean {
  if (String(order.order_type ?? "product").toLowerCase() !== "product") return false;
  if (order.replacement_of) return false;
  return true;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// NET revenue for an order = money actually kept after refunds. Gross
// `amount_paid` overstates revenue whenever any refund has been issued.
//
// This is THE definition of revenue for the whole system — a $200 order refunded
// by $50 is $150 — and every reporting surface must reach it, either through
// this function or through the identical expression in the SQL rollups.
//
// SIGNED, NOT CLAMPED, AND THAT IS THE AGREED CONVENTION.
//
// This used to return `max(0, paid − refunded)` while the profit engine
// (order-profit.ts) subtracted the refund unfloored, so an order paid $100 and
// refunded $150 was −$50 on the profit dashboard and $0 here, on /admin/revenue,
// in analytics, in the campaign report and in the SQL rollups. Two definitions
// of revenue is the one thing this module exists to prevent.
//
// The convention picked is REVENUE IS CASH: collected minus returned, keeping
// its sign. A clamp does not make the money come back — it reports an order the
// store lost money on as having broken even, and it does so on the surfaces the
// owner reads first. The loss is real, so it is shown. Held by
// revenue-clamp-agreement.test.ts, and mirrored in
// sql/admin-dashboard-rollups.sql (which must be re-run for the RPC path to
// agree; the JS fallback and the profit engine agree from this commit).
export function netOrderRevenue(order: { amount_paid?: number | null; refund_amount?: number | null }): number {
  const paid = Number(order.amount_paid ?? 0);
  const refunded = Number(order.refund_amount ?? 0);
  return round2(paid - refunded);
}

// Sum of earned (non-reversed) commission for a set of ledger rows — the ONE
// definition of "commission earned" used by every partner/admin surface.
export function sumEarnedCommission(
  rows: Array<{ commission_amount?: number | null; payment_status?: string | null }>,
): number {
  return round2(
    rows.reduce((sum, row) => (isEarnedCommission(row.payment_status) ? sum + Number(row.commission_amount ?? 0) : sum), 0),
  );
}
