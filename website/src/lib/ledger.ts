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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// NET revenue for an order = money actually kept after refunds. Gross
// `amount_paid` overstates revenue whenever any refund has been issued.
//
// This is THE definition of revenue for the whole system — a $200 order refunded
// by $50 is $150 — and every reporting surface must reach it, either through
// this function or through the identical expression in the SQL rollups.
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
