import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canViewProfit } from "@/lib/admin-roles";
import { getCurrentOnlineVisitorCount, getRevenueWindowMetrics } from "@/lib/admin-analytics";
import { getProfitWindowMetrics, getProfitDashboard } from "@/lib/admin-profit";
import { getRevenueMetrics } from "@/lib/admin-revenue";
import { getAdminOrderRows } from "@/lib/admin-orders";
import { listAdminProducts } from "@/lib/admin-products";
import { getLowStockCount } from "@/lib/admin-inventory";
import { getReconciliationFlagCount } from "@/lib/admin-reconciliation";
import { getBucketCounts } from "@/lib/fulfillment-queues";
import { getOpenCriticalAlertCount } from "@/lib/monitoring";
import { EMPTY_WORK_QUEUE, summarizeWorkQueue } from "@/lib/admin-work-queue";
import { getAdminPartnerRows } from "@/lib/partner-portal";
import { AdminControlCenterClient } from "@/components/admin-control-center-client";
import { AdminLiveMetrics } from "@/components/admin-live-metrics";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default async function AdminHomePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const [orderList, products, partners, onlineVisitors, revenueWindows, revenueMetrics, lowStockCount, reconciliationFlagCount, profitWindows] = await Promise.all([
    getAdminOrderRows({ pageSize: 25, paymentStatus: "active" }).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 })),
    listAdminProducts({ search: "", category: "all", status: "all" }).catch(() => []),
    getAdminPartnerRows({ status: "all" }).catch(() => []),
    getCurrentOnlineVisitorCount().catch(() => 0),
    getRevenueWindowMetrics().catch(() => ({ today: 0, last7Days: 0, last30Days: 0 })),
    getRevenueMetrics().catch(() => null),
    getLowStockCount().catch(() => 0),
    getReconciliationFlagCount().catch(() => 0),
    getProfitWindowMetrics().catch(() => ({ today: 0, last7Days: 0, last30Days: 0, ordersLast30Days: 0, hasEstimatedCost: false })),
  ]);

  // What is waiting for a human. Same buckets the workstation renders, so the
  // dashboard headline and the pick queue cannot disagree.
  const [workBuckets, openCriticals] = await Promise.all([
    getBucketCounts().catch(() => null),
    getOpenCriticalAlertCount().catch(() => 0),
  ]);
  const work = workBuckets ? summarizeWorkQueue(workBuckets, openCriticals) : EMPTY_WORK_QUEUE;

  // Full profit analytics (calendar windows + lifetime aggregates) — only
  // fetched for roles allowed to see profit.
  const profitDashboard = canViewProfit(session.role)
    ? await getProfitDashboard().catch(() => null)
    : null;

  const orders = orderList.rows;
  const publishedProducts = products.filter((product) => product.isPublished && product.isEnabled && !product.isArchived).length;
  const pendingPartners = partners.filter((partner) => partner.status === "pending").length;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Admin Control</p>
              <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Store Operations Dashboard</h1>
              <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
                Manage products, orders, promotions, homepage content, and settings without editing code or database records directly.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/products" className="vl-btn-secondary px-4 py-2 text-xs">Products</Link>
              <Link href="/admin/orders" className="vl-btn-secondary px-4 py-2 text-xs">Orders</Link>
              <Link href="/admin/partners" className="vl-btn-secondary px-4 py-2 text-xs">Partners</Link>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {/*
            THE FIRST NUMBER ON THE PAGE, because it is the only one that
            implies an action. This dashboard previously opened with revenue and
            profit and never stated how many orders were waiting to ship — with
            60 in the queue, the number 60 appeared nowhere on the screen.
          */}
          <Link
            href="/admin/fulfillment/workstation"
            className="vl-panel rounded-2xl p-4 transition hover:border-white/25 sm:col-span-2"
          >
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Needs Fulfillment</p>
            <p className={work.needsFulfillment > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>
              {work.needsFulfillment}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {work.inProgress} in progress
              {work.exceptions > 0 ? ` \u00b7 ${work.exceptions} need attention` : ""}
              {work.openCriticalAlerts > 0 ? ` \u00b7 ${work.openCriticalAlerts} critical alert${work.openCriticalAlerts === 1 ? "" : "s"}` : ""}
            </p>
          </Link>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Paid Orders</p>
            <p className="mt-2 text-2xl font-semibold text-white">{revenueMetrics?.totalPaidOrders ?? 0}</p>
            <p className="mt-1 text-[11px] text-zinc-500">completed sales</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue · 30d</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(revenueWindows.last30Days)}</p>
            <p className="mt-1 text-[11px] text-zinc-500">Today {money(revenueWindows.today)} · 7d {money(revenueWindows.last7Days)}</p>
          </div>
          {canViewProfit(session.role) ? (
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Net Profit · 30d</p>
            <p className={`mt-2 text-2xl font-semibold ${profitWindows.last30Days >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(profitWindows.last30Days)}</p>
            <p className="mt-1 text-[11px] text-zinc-500">Today {money(profitWindows.today)} · 7d {money(profitWindows.last7Days)}{profitWindows.hasEstimatedCost ? " · incl. estimates" : ""}</p>
          </div>
          ) : null}
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Published Products</p>
            <p className="mt-2 text-2xl font-semibold text-white">{publishedProducts}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Pending Partners</p>
            <p className="mt-2 text-2xl font-semibold text-white">{pendingPartners}</p>
          </div>
          <Link href="/admin/inventory" className="vl-panel rounded-2xl p-4 transition hover:border-white/25">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Low Stock</p>
            <p className={lowStockCount > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>{lowStockCount}</p>
          </Link>
          <Link href="/admin/reconciliation" className="vl-panel rounded-2xl p-4 transition hover:border-white/25">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Reconciliation Flags</p>
            <p className={reconciliationFlagCount > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>{reconciliationFlagCount}</p>
          </Link>
          <AdminLiveMetrics
            initial={{
              onlineNow: onlineVisitors,
              revenue: revenueWindows,
              selectedRange: {
                preset: "7d",
                fromIso: "",
                toIso: "",
                total: revenueWindows.last7Days,
                trend: [],
              },
              updatedAt: new Date().toISOString(),
            }}
          />
        </section>

        {profitDashboard ? (
          <section className="vl-panel rounded-[1.6rem] p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Profit Analytics</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Net Profit</h2>
                <p className="mt-2 text-sm text-zinc-400">
                  Real net profit — revenue minus product cost, processor fees, and shipping. Sales tax is excluded (it&apos;s remitted to the state).
                  {profitDashboard.hasEstimatedProfit
                    ? ` ${profitDashboard.estimatedOrderCount} order${profitDashboard.estimatedOrderCount === 1 ? "" : "s"} still estimated (exact shipping cost pending).`
                    : ""}
                </p>
              </div>
              <Link href="/admin/revenue" className="vl-btn-secondary px-4 py-2 text-xs">Revenue Detail</Link>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {([
                ["Today", profitDashboard.profit.today],
                ["Yesterday", profitDashboard.profit.yesterday],
                ["This Week", profitDashboard.profit.thisWeek],
                ["This Month", profitDashboard.profit.thisMonth],
                ["This Year", profitDashboard.profit.thisYear],
                ["Lifetime", profitDashboard.profit.lifetime],
              ] as Array<[string, number]>).map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{label}</p>
                  <p className={`mt-2 text-xl font-semibold tabular-nums ${value >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(value)}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {([
                ["Gross revenue", money(profitDashboard.lifetime.grossRevenue)],
                ["Net margin", `${profitDashboard.lifetime.netMarginPercent.toFixed(1)}%`],
                ["Gross margin", `${profitDashboard.lifetime.grossMarginPercent.toFixed(1)}%`],
                ["Avg order value", money(profitDashboard.lifetime.averageOrderValue)],
                ["Avg profit / order", money(profitDashboard.lifetime.averageProfitPerOrder)],
                ["Product costs", money(profitDashboard.lifetime.totalProductCosts)],
                ["Processor fees", money(profitDashboard.lifetime.totalProcessorFees)],
                ["Shipping revenue", money(profitDashboard.lifetime.totalShippingRevenue)],
                ["Shipping expense", money(profitDashboard.lifetime.totalShippingExpense)],
                ["Shipping profit", money(profitDashboard.lifetime.totalShippingProfit)],
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between rounded-xl border border-white/5 bg-white/[0.015] px-3 py-2">
                  <span className="text-zinc-400">{label}</span>
                  <span className="tabular-nums text-zinc-100">{value}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-zinc-500">Lifetime figures across {profitDashboard.lifetime.orderCount} paid order{profitDashboard.lifetime.orderCount === 1 ? "" : "s"}.</p>
          </section>
        ) : null}

        <section className="vl-panel rounded-[1.6rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Orders Snapshot</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Recent Orders</h2>
              <p className="mt-2 text-sm text-zinc-400">Latest paid and pending orders visible right inside admin home.</p>
            </div>
            <Link href="/admin/orders" className="vl-btn-secondary px-4 py-2 text-xs">Open Full Orders</Link>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400">
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Payment</th>
                  <th className="px-3 py-2 font-medium">Items</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 10).map((order) => (
                  <tr key={order.id} className="border-b border-white/5 text-zinc-200">
                    <td className="px-3 py-2">
                      <Link href={`/admin/orders/${order.order_id}`} className="transition hover:text-white">
                        {order.order_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{order.customer_email ?? "Unknown"}</td>
                    <td className="px-3 py-2">{money(Number(order.amount_paid ?? 0))}</td>
                    <td className="px-3 py-2">{order.payment_status}</td>
                    <td className="px-3 py-2">{order.item_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {orders.length === 0 ? (
              <p className="px-3 py-6 text-sm text-zinc-400">No orders yet.</p>
            ) : null}
          </div>
        </section>

        <AdminControlCenterClient />
      </div>
    </div>
  );
}