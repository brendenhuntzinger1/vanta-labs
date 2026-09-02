import "server-only";
import { startOfBusinessDate } from "@/lib/business-day";

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
  /**
   * The share of this order's tax that went back to the customer. Zero on an
   * untouched order, the whole of `taxCollected` on a full refund, and a
   * proportion of it on a partial — see refundedTaxFor below.
   */
  taxRefunded: number;
  /** taxCollected − taxRefunded: what this order actually owes the state. */
  netTax: number;
  paymentStatus: string;
  /**
   * True for ANY refund, partial or full — a partial refund is still a refund,
   * and calling it false on a filing report would be a false negative. No
   * surface reads this today; `taxRefunded`/`netTax` carry the money.
   */
  refunded: boolean;
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

// One rule for "what share of the tax came back", and it lives in
// refundedTaxFor below. A second implementation of it arrived from a parallel
// session and is deliberately not kept: two functions answering the same
// question about the same money is how a filing report and a profit report end
// up disagreeing about one refund.

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
//
// PARTIAL REFUNDS. `partially_refunded` is in neither PAID_ORDER_STATUSES nor
// the `=== "refunded"` test, so such an order used to fall through the skip
// above and disappear from the filing entirely — the store under-reported the
// tax it still owed on the part the customer kept. `orders.refund_amount` was
// not read anywhere in this file.
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
        // A FILING YEAR IS THE STORE'S YEAR. On UTC, a sale at 8pm ET on
        // December 31st fell into the next year's return and out of the one it
        // was actually made in — a filing that no reconciliation would catch,
        // because both years looked internally consistent.
        query = query
          .gte("created_at", startOfBusinessDate(options.year, 1, 1).toISOString())
          .lt("created_at", startOfBusinessDate(options.year + 1, 1, 1).toISOString());
      }
      return query as unknown as PromiseLike<{ data: OrderRecord[] | null; error: { message?: string } | null }>;
    },
    { maxRows: MAX_TAX_ORDERS, label: "Unable to load tax report" },
  );

  for (const order of records) {
    const status = String(order.payment_status ?? "").toLowerCase();
    const fullyRefunded = status === "refunded";
    // A partially refunded order KEPT the sale and the tax on the part the
    // customer did not get back. It is neither in PAID_ORDER_STATUSES nor
    // equal to "refunded", so it used to fall through the skip below and
    // vanish from the filing entirely, tax and all.
    const partiallyRefunded = status === "partially_refunded";
    const collected = PAID_ORDER_STATUSES.has(status) || partiallyRefunded || fullyRefunded;
    // Pending/failed/cancelled orders never collected the tax — skip.
    if (!collected) continue;
    // Prefer the exact recorded jurisdiction; orders that predate the
    // tax_state column fall back to the shipping state.
    const state = order.tax_state ?? normalizeUsState(order.state) ?? "UNKNOWN";
    const taxCollected = roundMoney(Number(order.tax_amount ?? 0));
    const taxRefunded = refundedTaxFor(order);
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
      refunded: fullyRefunded || partiallyRefunded,
    });
  }

  const byStateMap = new Map<string, TaxStateSummary>();
  for (const row of rows) {
    const entry = byStateMap.get(row.state) ?? { state: row.state, orders: 0, taxableSales: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 };
    entry.orders += 1;
    // COLLECTED AND REFUNDED ARE SEPARATE LINES ON A RETURN, and every taxed
    // order belongs on the first one. The money WAS collected on every order
    // here, refunded or not — a refund is a movement in the other direction,
    // not an erasure of the collection. Adding a full refund only to
    // taxRefunded, and never to taxCollected, pushed netTax below zero by the
    // order's own tax: a single fully-refunded $6.00-tax order reported the
    // state owing the store $6.00.
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

  return { rows, byState, totals, truncated };
}
