// ============================================================================
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// NET revenue for a captured order = money actually kept after refunds. Gross
// `amount_paid` overstates revenue whenever a PARTIAL refund left the order in
// "paid" (a full refund flips status out of "paid" and is excluded upstream).
export function netOrderRevenue(order: { amount_paid?: number | null; refund_amount?: number | null }): number {
  const paid = Number(order.amount_paid ?? 0);
  const refunded = Number(order.refund_amount ?? 0);
  return round2(Math.max(0, paid - refunded));
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
