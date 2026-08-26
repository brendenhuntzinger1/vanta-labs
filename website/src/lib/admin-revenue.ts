import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES, netOrderRevenue, NON_SALE_ORDER_TYPES } from "@/lib/ledger";

export interface RevenueByMethod {
  method: string;
  label: string;
  revenue: number;
  orders: number;
}

export interface RevenueMetrics {
  todayRevenue: number;
  todayOrders: number;
  totalPaidRevenue: number;
  totalPaidOrders: number;
  averageOrderValue: number;
  processingFeesCollected: number;
  pendingPayments: number;
  approvedPayments: number;
  awaitingFulfillment: number;
  shipped: number;
  byMethod: RevenueByMethod[];
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

const METHOD_LABELS: Record<string, string> = {
  cashapp: "Cash App",
  zelle: "Zelle",
  paypal: "PayPal",
  venmo: "Venmo",
  card: "Credit Card",
};

function methodLabel(method: string) {
  return METHOD_LABELS[method] ?? (method ? method : "Unspecified");
}

// Aggregates the manual-payment revenue dashboard. Counts use head:true count
// queries; revenue totals fetch paid orders' amounts and aggregate in JS
// (Supabase-js has no SUM without an RPC). Fine for a dashboard-scale table.
export async function getRevenueMetrics(): Promise<RevenueMetrics> {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const [pending, approved, awaiting, shippedResult, summaryRpc, byMethodRpc] = await Promise.all([
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).in("payment_status", ["pending_payment", "awaiting_verification"]),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid"),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid").eq("fulfillment_status", "awaiting_fulfillment"),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("fulfillment_status", "shipped"),
    // Aggregate revenue in Postgres (one grouped pass, no row transfer, no cap).
    // Falls back to the legacy 10k-capped JS scan if the RPC isn't migrated yet
    // — see src/lib/sql/admin-dashboard-rollups.sql.
    supabaseAdmin.rpc("admin_revenue_summary", { p_start_of_today: startOfToday }),
    supabaseAdmin.rpc("admin_revenue_by_method"),
  ]);

  const pendingPayments = pending.count ?? 0;
  const approvedPayments = approved.count ?? 0;
  const awaitingFulfillment = awaiting.count ?? 0;
  const shipped = shippedResult.count ?? 0;

  let totalPaidRevenue = 0;
  let processingFeesCollected = 0;
  let todayRevenue = 0;
  let todayOrders = 0;
  let totalPaidOrders = 0;
  let byMethod: RevenueByMethod[];

  const summaryRow = Array.isArray(summaryRpc.data) ? summaryRpc.data[0] : undefined;
  if (!summaryRpc.error && summaryRow && !byMethodRpc.error && Array.isArray(byMethodRpc.data)) {
    totalPaidRevenue = Number((summaryRow as Record<string, unknown>).total_paid_revenue ?? 0);
    totalPaidOrders = Number((summaryRow as Record<string, unknown>).total_paid_orders ?? 0);
    processingFeesCollected = Number((summaryRow as Record<string, unknown>).processing_fees ?? 0);
    todayRevenue = Number((summaryRow as Record<string, unknown>).today_revenue ?? 0);
    todayOrders = Number((summaryRow as Record<string, unknown>).today_orders ?? 0);
    byMethod = (byMethodRpc.data as Array<Record<string, unknown>>)
      .map((row) => ({
        method: String(row.method ?? ""),
        label: methodLabel(String(row.method ?? "")),
        revenue: roundMoney(Number(row.revenue ?? 0)),
        orders: Number(row.orders ?? 0),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  } else {
    // Fallback: RPC not present — legacy 10k-capped scan + JS aggregation
    // (identical math). Run the migration to remove the cap at scale.
    // Reshipments are paid rows with amount_paid 0. They add nothing to revenue
    // and a $0 denominator to average order value, so they are not sales here
    // either — the same exclusion the rollup function applies.
    let paidQuery = supabaseAdmin
      .from("orders")
      .select("amount_paid, refund_amount, payment_method, card_processing_fee, paid_at")
      .in("payment_status", Array.from(PAID_ORDER_STATUSES));
    for (const orderType of NON_SALE_ORDER_TYPES) paidQuery = paidQuery.neq("order_type", orderType);
    const paidResult = await paidQuery.limit(10000);
    if (paidResult.error) {
      throw paidResult.error;
    }
    const paidOrders = paidResult.data ?? [];
    const methodMap = new Map<string, { revenue: number; orders: number }>();

    for (const order of paidOrders) {
      const amount = netOrderRevenue(order);
      const fee = Number(order.card_processing_fee ?? 0);
      const method = String(order.payment_method ?? "");

      totalPaidRevenue += amount;
      processingFeesCollected += fee;

      const entry = methodMap.get(method) ?? { revenue: 0, orders: 0 };
      entry.revenue += amount;
      entry.orders += 1;
      methodMap.set(method, entry);

      if (order.paid_at && String(order.paid_at) >= startOfToday) {
        todayRevenue += amount;
        todayOrders += 1;
      }
    }

    totalPaidOrders = paidOrders.length;
    byMethod = Array.from(methodMap.entries())
      .map(([method, value]) => ({
        method,
        label: methodLabel(method),
        revenue: roundMoney(value.revenue),
        orders: value.orders,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  return {
    todayRevenue: roundMoney(todayRevenue),
    todayOrders,
    totalPaidRevenue: roundMoney(totalPaidRevenue),
    totalPaidOrders,
    averageOrderValue: totalPaidOrders > 0 ? roundMoney(totalPaidRevenue / totalPaidOrders) : 0,
    processingFeesCollected: roundMoney(processingFeesCollected),
    pendingPayments,
    approvedPayments,
    awaitingFulfillment,
    shipped,
    byMethod,
  };
}
