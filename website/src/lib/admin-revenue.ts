import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

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

  const [pending, approved, awaiting, shippedResult, paidResult] = await Promise.all([
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).in("payment_status", ["pending_payment", "awaiting_verification"]),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid"),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid").eq("fulfillment_status", "awaiting_fulfillment"),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("fulfillment_status", "shipped"),
    supabaseAdmin
      .from("orders")
      .select("amount_paid, payment_method, card_processing_fee, paid_at")
      .eq("payment_status", "paid")
      .limit(10000),
  ]);

  if (paidResult.error) {
    throw paidResult.error;
  }

  const pendingPayments = pending.count ?? 0;
  const approvedPayments = approved.count ?? 0;
  const awaitingFulfillment = awaiting.count ?? 0;
  const shipped = shippedResult.count ?? 0;
  const paidOrders = paidResult.data ?? [];

  let totalPaidRevenue = 0;
  let processingFeesCollected = 0;
  let todayRevenue = 0;
  let todayOrders = 0;
  const methodMap = new Map<string, { revenue: number; orders: number }>();

  for (const order of paidOrders) {
    const amount = Number(order.amount_paid ?? 0);
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

  const totalPaidOrders = paidOrders.length;

  const byMethod: RevenueByMethod[] = Array.from(methodMap.entries())
    .map(([method, value]) => ({
      method,
      label: methodLabel(method),
      revenue: roundMoney(value.revenue),
      orders: value.orders,
    }))
    .sort((a, b) => b.revenue - a.revenue);

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
