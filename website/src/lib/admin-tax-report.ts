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
  paymentStatus: string;
  refunded: boolean;
}

export interface TaxStateSummary {
  state: string;
  orders: number;
  taxableSales: number;
  taxCollected: number;
  /** Tax on fully-refunded orders (returned to the customer). */
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
}

// Year is optional; default = everything. Only orders that actually carried
// tax appear — a $0-tax order (non-nexus destination) has nothing to remit.
export async function getSalesTaxReport(options?: { year?: number }): Promise<SalesTaxReport> {
  const rows: TaxOrderRow[] = [];
  const pageSize = 1000;

  for (let page = 0; page < 20; page += 1) {
    let query = supabaseAdmin
      .from("orders")
      .select("order_number, created_at, state, tax_state, tax_amount, tax_rate_percent, subtotal, discount_amount, payment_status")
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
      const refunded = status === "refunded";
      // Pending/failed/cancelled orders never collected the tax — skip.
      if (!paid && !refunded) continue;
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
      });
    }
    if (batch.length < pageSize) break;
  }

  const byStateMap = new Map<string, TaxStateSummary>();
  for (const row of rows) {
    const entry = byStateMap.get(row.state) ?? { state: row.state, orders: 0, taxableSales: 0, taxCollected: 0, taxRefunded: 0, netTax: 0 };
    entry.orders += 1;
    if (row.refunded) {
      entry.taxRefunded = roundMoney(entry.taxRefunded + row.taxCollected);
    } else {
      entry.taxableSales = roundMoney(entry.taxableSales + row.taxableSales);
      entry.taxCollected = roundMoney(entry.taxCollected + row.taxCollected);
    }
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

  return { rows, byState, totals };
}
