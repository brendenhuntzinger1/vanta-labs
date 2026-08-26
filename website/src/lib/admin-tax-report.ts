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
import { readAllRowsBounded } from "@/lib/supabase-page";

export interface TaxOrderRow {
  orderNumber: string;
  createdAt: string;
  state: string;
  ratePercent: number;
  taxableSales: number;
  taxCollected: number;
  paymentStatus: string;
  /** True only for a FULL refund. Kept for the existing CSV/table columns. */
  refunded: boolean;
  /** Tax handed back on this order — the whole amount on a full refund, the
   *  refunded share on a partial one, 0 on a clean sale. */
  taxRefunded: number;
}

export interface TaxStateSummary {
  state: string;
  orders: number;
  taxableSales: number;
  taxCollected: number;
  /** Tax handed back to customers — full refunds plus the refunded share of
   *  partial ones. */
  taxRefunded: number;
  netTax: number;
}

export interface SalesTaxReport {
  rows: TaxOrderRow[];
  byState: TaxStateSummary[];
  totals: { orders: number; taxCollected: number; taxRefunded: number; netTax: number };
  /**
   * True when MAX_TAX_ORDERS stopped the read before every taxed order had been
   * seen. A filing report that is quietly short is worse than one that says it
   * is short, so this is reported rather than swallowed.
   */
  truncated: boolean;
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
  amount_paid: number | null;
  refund_amount: number | null;
  payment_status: string | null;
}

// Ceiling on one report, not a definition of the answer — see `truncated`.
const MAX_TAX_ORDERS = 200_000;

// Sales tax is charged on the sale, so a refund of part of a sale returns that
// same part of its tax. Nothing records the tax portion of a refund, so it is
// derived from the only two figures that exist: how much the customer paid, and
// how much came back. A full refund gives a ratio of exactly 1.
//
// Deriving it, rather than reading a column, is stated here because a filing is
// involved: if a partial-refund tax column is ever added, this is what it
// replaces.
export function refundedTaxFor(order: {
  tax_amount: number | null;
  amount_paid: number | null;
  refund_amount: number | null;
  payment_status: string | null;
}): number {
  const tax = Math.max(0, Number(order.tax_amount ?? 0));
  const refund = Math.max(0, Number(order.refund_amount ?? 0));
  if (tax === 0 || refund === 0) {
    // A row marked "refunded" with no recorded refund_amount predates that
    // column being written; the status is the only evidence, so trust it.
    return String(order.payment_status ?? "").toLowerCase() === "refunded" ? tax : 0;
  }
  const paid = Math.max(0, Number(order.amount_paid ?? 0));
  if (paid <= 0) return tax;
  return roundMoney(Math.min(tax, tax * Math.min(1, refund / paid)));
}

// Year is optional; default = everything. Only orders that actually carried
// tax appear — a $0-tax order (non-nexus destination) has nothing to remit.
export async function getSalesTaxReport(options?: { year?: number }): Promise<SalesTaxReport> {
  const rows: TaxOrderRow[] = [];

  // Paged to exhaustion. The previous 20-page ceiling silently stopped at
  // 20,000 taxed orders and reported whatever it had as the whole filing.
  const { rows: records, truncated } = await readAllRowsBounded<OrderRecord>(
    (from, to) => {
      let query = supabaseAdmin
        .from("orders")
        .select("order_number, created_at, state, tax_state, tax_amount, tax_rate_percent, subtotal, discount_amount, amount_paid, refund_amount, payment_status")
        .gt("tax_amount", 0)
        // created_at is not unique, so it alone cannot page deterministically —
        // rows on a shared timestamp could repeat or vanish across pages.
        .order("created_at", { ascending: false })
        .order("order_number", { ascending: true })
        .range(from, to);
      if (options?.year) {
        query = query
          .gte("created_at", `${options.year}-01-01T00:00:00Z`)
          .lt("created_at", `${options.year + 1}-01-01T00:00:00Z`);
      }
      return query as unknown as PromiseLike<{ data: OrderRecord[] | null; error: { message?: string } | null }>;
    },
    { maxRows: MAX_TAX_ORDERS, label: "Unable to load tax report" },
  );

  for (const order of records) {
    const status = String(order.payment_status ?? "").toLowerCase();
    const refunded = status === "refunded";
    // A partially refunded order KEPT the sale and the tax on the part the
    // customer did not get back. It is neither in PAID_ORDER_STATUSES nor
    // equal to "refunded", so it used to fall through the skip below and
    // vanish from the filing entirely, tax and all.
    const partiallyRefunded = status === "partially_refunded";
    const collected = PAID_ORDER_STATUSES.has(status) || partiallyRefunded || refunded;
    // Pending/failed/cancelled orders never collected the tax — skip.
    if (!collected) continue;
    // Prefer the exact recorded jurisdiction; orders that predate the
    // tax_state column fall back to the shipping state.
    const state = order.tax_state ?? normalizeUsState(order.state) ?? "UNKNOWN";
    rows.push({
      orderNumber: order.order_number ?? "",
      createdAt: order.created_at ?? "",
      state,
      ratePercent: Number(order.tax_rate_percent ?? 0),
      taxableSales: roundMoney(Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0))),
      taxCollected: roundMoney(Number(order.tax_amount ?? 0)),
      paymentStatus: status,
      refunded,
      taxRefunded: refundedTaxFor(order),
    });
  }

  const byStateMap = new Map<string, TaxStateSummary>();
  for (const row of rows) {
    const entry = byStateMap.get(row.state) ?? { state: row.state, orders: 0, taxableSales: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 };
    entry.orders += 1;
    // COLLECTED AND REFUNDED ARE SEPARATE LINES ON A RETURN, and every taxed
    // order belongs on the first one. A refund used to be recorded ONLY as a
    // refund — the same order's collection was never added — so each refunded
    // order pushed net tax below zero by its own tax, and a state whose only
    // taxed order was refunded reported a negative amount due.
    entry.taxableSales = roundMoney(entry.taxableSales + row.taxableSales);
    entry.taxCollected = roundMoney(entry.taxCollected + row.taxCollected);
    entry.taxRefunded = roundMoney(entry.taxRefunded + row.taxRefunded);
    entry.netTax = roundMoney(entry.taxCollected - entry.taxRefunded);
    byStateMap.set(row.state, entry);
  }

  const byState = Array.from(byStateMap.values()).sort((a, b) => b.netTax - a.netTax);
  const totals = byState.reduce(
    (acc, s) => ({
      orders: acc.orders + s.orders,
      taxCollected: roundMoney(acc.taxCollected + s.taxCollected),
      taxRefunded: roundMoney(acc.taxRefunded + s.taxRefunded),
      netTax: roundMoney(acc.netTax + s.netTax),
    }),
    { orders: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 },
  );

  return { rows, byState, totals, truncated };
}
