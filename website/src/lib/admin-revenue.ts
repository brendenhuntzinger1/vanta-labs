import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { REVENUE_ORDER_STATUSES, netOrderRevenue, NON_SALE_ORDER_TYPES } from "@/lib/ledger";
import { rawStatusesFor } from "@/lib/order-pipeline";
import { readAllRowsBounded } from "@/lib/supabase-page";

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

// Ceiling on the RPC-less fallback, not a definition of the answer.
const MAX_REVENUE_ORDERS = 200_000;

// Aggregates the manual-payment revenue dashboard. Counts use head:true count
// queries; revenue totals fetch paid orders' amounts and aggregate in JS
// (Supabase-js has no SUM without an RPC). Fine for a dashboard-scale table.
export async function getRevenueMetrics(): Promise<RevenueMetrics> {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const [pending, approved, awaiting, shippedResult, summaryRpc, byMethodRpc] = await Promise.all([
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).in("payment_status", ["pending_payment", "awaiting_verification"]),
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "paid"),
    // AWAITING FULFILLMENT — two bugs lived in one line here.
    //
    // It matched the single literal `awaiting_fulfillment`, so every order
    // sitting in the pick queue as `paid`, `ready_to_fulfill`, `processing` or
    // `sent_to_fulfillment` was invisible: driven with 60 orders waiting, this
    // reported 0 while the workstation reported 60. And it counted MEMBERSHIP
    // orders, which never ship — ledger.ts is explicit that a membership is a
    // sale but not a fulfilment.
    supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("payment_status", "paid")
      .neq("order_type", "membership")
      .in("fulfillment_status", [...rawStatusesFor("paid"), ...rawStatusesFor("ready_to_fulfill")]),
    // Same synonym problem, plus it counted shipped rows whose payment never
    // landed. A shipped order that was not paid is a fulfilment mistake, not a
    // shipment to report.
    supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("payment_status", "paid")
      .in("fulfillment_status", rawStatusesFor("shipped")),
    // Aggregate revenue in Postgres (one grouped pass, no row transfer). Falls
    // back to a paged JS scan if the RPC isn't migrated yet — see
    // src/lib/sql/admin-dashboard-rollups.sql. Both paths now answer with the
    // same total; the fallback is slower, not smaller.
    supabaseAdmin.rpc("admin_revenue_summary", { p_start_of_today: startOfToday }),
    supabaseAdmin.rpc("admin_revenue_by_method"),
  ]);

  const pendingPayments = pending.count ?? 0;
  // NOT the same number as totalPaidOrders, and not labelled as if it were:
  // this counts rows whose status is exactly "paid", where totalPaidOrders
  // counts every status that contributes revenue (REVENUE_ORDER_STATUSES,
  // which also includes partially_refunded). The two differ by the partly
  // refunded orders, deliberately.
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
    // Fallback: RPC not present — the same aggregation in JS, over the same
    // rows the RPC filters on. Two separate corrections live here and neither
    // subsumes the other:
    //
    // 1. It used to be one `.limit(10000)`. Past ten thousand revenue orders it
    //    returned ten thousand of them and the page reported that as the
    //    store's lifetime revenue — so whether the admin_revenue_summary
    //    migration had been run changed the headline number, silently, with no
    //    way to tell from the screen which figure you were looking at. It is
    //    paged to exhaustion so both paths answer with the same total.
    // 2. Reshipments are `paid` rows with amount_paid 0. They add nothing to
    //    revenue and a $0 denominator to average order value, so 100 sales plus
    //    3 reships used to report 103 orders. They are excluded here, the same
    //    exclusion the rollup function applies.
    type PaidRow = {
      amount_paid: number | null;
      refund_amount: number | null;
      payment_method: string | null;
      card_processing_fee: number | null;
      paid_at: string | null;
    };
    const { rows: paidOrders } = await readAllRowsBounded<PaidRow>(
      (from, to) => {
        let query = supabaseAdmin
          .from("orders")
          .select("amount_paid, refund_amount, payment_method, card_processing_fee, paid_at")
          .in("payment_status", Array.from(REVENUE_ORDER_STATUSES));
        for (const orderType of NON_SALE_ORDER_TYPES) query = query.neq("order_type", orderType);
        return query
          // Any stable key will do; paging without one can repeat or skip rows.
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: PaidRow[] | null; error: { message?: string } | null }>;
      },
      { maxRows: MAX_REVENUE_ORDERS, label: "revenue read" },
    );
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
