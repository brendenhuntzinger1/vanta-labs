import "server-only";

// Sales-tax recordkeeping for the admin dashboard: exactly how much tax was
// collected, per order and per state — the numbers the owner files with each
// state's revenue department. Reads only what checkout stored on the order
// (tax_amount, tax_rate_percent, tax_state), never re-derives rates, so the
// report always matches what customers were actually charged.

import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import { normalizeUsState } from "@/lib/sales-tax";
import { roundMoney } from "@/lib/shipping";

export interface TaxOrderRow {
  orderNumber: string;
  createdAt: string;
  state: string;
  ratePercent: number;
  taxableSales: number;
  taxCollected: number;
  /**
   * The share of this order's tax that went back to the customer. Zero on an
   * untouched order, the whole of `taxCollected` on a full refund, and a
   * proportion of it on a partial — see refundedProportionOf below.
   */
  taxRefunded: number;
  /** taxCollected − taxRefunded: what this order actually owes the state. */
  netTax: number;
  paymentStatus: string;
  /** True for any refund, partial or full. A partial is NOT a full collection. */
  refunded: boolean;
}

export interface TaxStateSummary {
  state: string;
  orders: number;
  taxableSales: number;
  taxCollected: number;
  /** Tax returned to customers — from full AND partial refunds. */
  taxRefunded: number;
  netTax: number;
}

export interface SalesTaxReport {
  rows: TaxOrderRow[];
  byState: TaxStateSummary[];
  totals: { orders: number; taxCollected: number; taxRefunded: number; netTax: number };
}

interface OrderRecord {
  order_number: string | null;
  created_at: string | null;
  state: string | null;
  tax_state: string | null;
  tax_amount: number | null;
  tax_rate_percent: number | null;
  subtotal: number | null;
  discount_amount: number | null;
  payment_status: string | null;
  amount_paid: number | null;
  refund_amount: number | null;
}

/**
 * How much of this order came back to the customer, as a fraction of what they
 * paid — the share of its sales tax that was returned with it.
 *
 * WHY A PROPORTION OF amount_paid. A refund is recorded as one dollar figure
 * against the order (`orders.refund_amount`, cumulative, written by both the
 * admin reimbursement path and the processor webhook). Nothing records how that
 * figure divided between merchandise, shipping, the card fee and the tax, so
 * the split is not recoverable from the row. Prorating on the order total is the
 * conventional approximation and the only one the stored data supports.
 *
 * ACCOUNTING POLICY, NOT A LAW OF NATURE. If the owner's accountant wants
 * refunds apportioned against the taxable base (subtotal − discount) instead,
 * that is a one-line change here — and it is the only place it would need to
 * change, which is the point of it living in one function.
 *
 * A `refunded` order is a full refund by definition, whatever refund_amount
 * happens to hold: a chargeback can land that status with the column still 0,
 * and treating that as "nothing was returned" would over-remit.
 */
function refundedProportionOf(
  order: Pick<OrderRecord, "amount_paid" | "refund_amount">,
  fullyRefunded: boolean,
  partiallyRefunded: boolean,
): number {
  if (fullyRefunded) return 1;
  if (!partiallyRefunded) return 0;
  const paid = Number(order.amount_paid ?? 0);
  const refunded = Number(order.refund_amount ?? 0);
  if (!(paid > 0) || !(refunded > 0)) return 0;
  // Clamped: a duplicated or mistyped refund must never turn into a credit the
  // state never gave.
  return Math.min(1, refunded / paid);
}

// Year is optional; default = everything. Only orders that actually carried
// tax appear — a $0-tax order (non-nexus destination) has nothing to remit.
//
// PARTIAL REFUNDS. `partially_refunded` is in neither PAID_ORDER_STATUSES nor
// the `=== "refunded"` test, so such an order used to fall through the skip
// above and disappear from the filing entirely — the store under-reported the
// tax it still owed on the part the customer kept. `orders.refund_amount` was
// not read anywhere in this file.
export async function getSalesTaxReport(options?: { year?: number }): Promise<SalesTaxReport> {
  const rows: TaxOrderRow[] = [];
  const pageSize = 1000;

  for (let page = 0; page < 20; page += 1) {
    let query = supabaseAdmin
      .from("orders")
      .select("order_number, created_at, state, tax_state, tax_amount, tax_rate_percent, subtotal, discount_amount, payment_status, amount_paid, refund_amount")
      .gt("tax_amount", 0)
      .order("created_at", { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (options?.year) {
      query = query
        .gte("created_at", `${options.year}-01-01T00:00:00Z`)
        .lt("created_at", `${options.year + 1}-01-01T00:00:00Z`);
    }
    const { data, error } = await query;
    if (error) throw new Error(`Unable to load tax report: ${error.message}`);
    const batch = (data ?? []) as OrderRecord[];

    for (const order of batch) {
      const status = String(order.payment_status ?? "").toLowerCase();
      const paid = PAID_ORDER_STATUSES.has(status);
      const fullyRefunded = status === "refunded";
      const partiallyRefunded = status === "partially_refunded";
      // Pending/failed/cancelled orders never collected the tax — skip.
      if (!paid && !fullyRefunded && !partiallyRefunded) continue;
      const refunded = fullyRefunded || partiallyRefunded;
      // Prefer the exact recorded jurisdiction; orders that predate the
      // tax_state column fall back to the shipping state.
      const state = order.tax_state ?? normalizeUsState(order.state) ?? "UNKNOWN";
      const taxCollected = roundMoney(Number(order.tax_amount ?? 0));
      const taxRefunded = roundMoney(taxCollected * refundedProportionOf(order, fullyRefunded, partiallyRefunded));
      rows.push({
        orderNumber: order.order_number ?? "",
        createdAt: order.created_at ?? "",
        state,
        ratePercent: Number(order.tax_rate_percent ?? 0),
        taxableSales: roundMoney(Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0))),
        taxCollected,
        taxRefunded,
        netTax: roundMoney(taxCollected - taxRefunded),
        paymentStatus: status,
        refunded,
      });
    }
    if (batch.length < pageSize) break;
  }

  const byStateMap = new Map<string, TaxStateSummary>();
  for (const row of rows) {
    const entry = byStateMap.get(row.state) ?? { state: row.state, orders: 0, taxableSales: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 };
    entry.orders += 1;
    // The money WAS collected on every order here, refunded or not — a refund
    // is a separate movement in the other direction, not an erasure of the
    // collection. Adding a full refund only to taxRefunded (and never to
    // taxCollected) made netTax go NEGATIVE: a single fully-refunded $6.00-tax
    // order reported the state owing the store $6.00.
    entry.taxableSales = roundMoney(entry.taxableSales + row.taxableSales);
    entry.taxCollected = roundMoney(entry.taxCollected + row.taxCollected);
    entry.taxRefunded = roundMoney(entry.taxRefunded + row.taxRefunded);
    entry.netTax = roundMoney(entry.taxCollected - entry.taxRefunded);
    byStateMap.set(row.state, entry);
  }

  const byState = Array.from(byStateMap.values()).sort((a, b) => b.netTax - a.netTax);
  // `taxableSales` now includes refunded orders' bases, so it is gross taxable
  // sales — matching taxCollected, which is also gross. Net of refunds is
  // netTax.
  const totals = byState.reduce(
    (acc, s) => ({
      orders: acc.orders + s.orders,
      taxCollected: roundMoney(acc.taxCollected + s.taxCollected),
      taxRefunded: roundMoney(acc.taxRefunded + s.taxRefunded),
      netTax: roundMoney(acc.netTax + s.netTax),
    }),
    { orders: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 },
  );

  return { rows, byState, totals };
}
