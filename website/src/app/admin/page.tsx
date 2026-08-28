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
import { failedReads, figure, settleRead, UNKNOWN_FIGURE } from "@/lib/admin-read";
import { AdminReadFailureNotice, AdminTruncationNotice } from "@/components/admin-data-notices";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

/**
 * A margin, or "n/a" when there is none to state. `null` arrives from
 * order-profit.marginPercentOf, which refuses to answer at or below zero
 * revenue — 0% there reads as "broke even" on a store that lost money.
 */
function percent(value: number | null) {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

export default async function AdminHomePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  // A FAILED READ IS NOT A ZERO — see admin-read.ts. Every figure below used to
  // arrive through `.catch(() => 0)`, so a database that would not answer
  // rendered this page as a calm store with no orders, no low stock, no
  // reconciliation flags and nothing waiting to ship.
  //
  // ONE round of reads, not three. These used to run as three awaited groups,
  // so the page cost the SUM of the slowest read in each group instead of the
  // slowest read overall — and the two most expensive of them, the
  // reconciliation scan and the lifetime profit analytics, sat in different
  // groups and could never overlap. Nothing here depends on anything else here,
  // so there was never a reason to stage them. Measured on the local harness at
  // 20,000 paid orders: 3.0s in three stages, 2.0s in one.
  const canSeeProfit = canViewProfit(session.role);
  const [
    orderListRead,
    productsRead,
    partnersRead,
    onlineVisitorsRead,
    revenueWindowsRead,
    revenueMetricsRead,
    lowStockRead,
    reconciliationFlagRead,
    profitWindowsRead,
    workRead,
    criticalsRead,
    profitDashboardRead,
  ] = await Promise.all([
    settleRead("Recent orders", () => getAdminOrderRows({ pageSize: 25, paymentStatus: "active" })),
    settleRead("Products", () => listAdminProducts({ search: "", category: "all", status: "all" })),
    settleRead("Partners", () => getAdminPartnerRows({ status: "all" })),
    settleRead("Visitors online", getCurrentOnlineVisitorCount),
    settleRead("Revenue windows", getRevenueWindowMetrics),
    settleRead("Order counts", getRevenueMetrics),
    settleRead("Low stock", getLowStockCount),
    settleRead("Reconciliation flags", getReconciliationFlagCount),
    settleRead("Net profit", getProfitWindowMetrics),
    // What is waiting for a human. Same buckets the workstation renders, so the
    // dashboard headline and the pick queue cannot disagree.
    settleRead("Fulfillment queue counts", getBucketCounts),
    settleRead("Critical alerts", getOpenCriticalAlertCount),
    // Full profit analytics (calendar windows + lifetime aggregates) — only
    // fetched for roles allowed to see profit.
    canSeeProfit ? settleRead("Profit analytics", getProfitDashboard) : Promise.resolve(null),
  ]);

  const work = workRead.ok && criticalsRead.ok
    ? summarizeWorkQueue(workRead.value.counts, criticalsRead.value)
    : EMPTY_WORK_QUEUE;
  const workKnown = workRead.ok && criticalsRead.ok;

  const profitDashboard = profitDashboardRead?.ok ? profitDashboardRead.value : null;

  const failures = failedReads([
    orderListRead,
    productsRead,
    partnersRead,
    revenueWindowsRead,
    revenueMetricsRead,
    lowStockRead,
    reconciliationFlagRead,
    onlineVisitorsRead,
    workRead,
    criticalsRead,
    ...(canSeeProfit ? [profitWindowsRead] : []),
    ...(profitDashboardRead ? [profitDashboardRead] : []),
  ]);

  // The `truncated` flags admin-profit has always computed and no screen has
  // ever rendered. Lifetime revenue, margin and order count computed from a
  // slice of history, presented as the whole of it.
  const truncatedSources = [
    ...(profitDashboard?.truncated ? ["the lifetime profit analytics"] : []),
    ...(profitWindowsRead.ok && profitWindowsRead.value.truncated ? ["the 30-day profit windows"] : []),
    ...(workRead.ok && workRead.value.truncated ? ["the fulfillment queue counts"] : []),
  ];

  const orderList = orderListRead.ok
    ? orderListRead.value
    : { rows: [] as Awaited<ReturnType<typeof getAdminOrderRows>>["rows"] };
  const revenueWindows = revenueWindowsRead.ok
    ? revenueWindowsRead.value
    : { today: 0, last7Days: 0, last30Days: 0 };
  const onlineVisitors = onlineVisitorsRead.ok ? onlineVisitorsRead.value : 0;
  // The live tile renders from a CLIENT component that refetches, so it was
  // treated as self-healing and left out of the notice. It is not:
  // /api/admin/metrics reads the same two sources, so when they are down the
  // refetch 500s and the placeholder zeros stay. Both reads that feed it are
  // now declared, and the tile is told they are placeholders.
  const liveMetricsUnavailable = !revenueWindowsRead.ok || !onlineVisitorsRead.ok;

  const orders = orderList.rows;

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

        <AdminReadFailureNotice failures={failures} />
        <AdminTruncationNotice
          sources={truncatedSources}
          detail="Every lifetime and window figure below is a floor. Nothing here should be reported as a total."
        />

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
            {/* AN UNREAD QUEUE IS NOT AN EMPTY QUEUE. A zero here is the single
                most consequential lie this dashboard can tell: it is the number
                the owner uses to decide whether to go and pack anything. */}
            <p className={workKnown && work.needsFulfillment > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>
              {workKnown ? work.needsFulfillment : UNKNOWN_FIGURE}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {workKnown ? (
                <>
                  {work.inProgress} in progress
                  {work.exceptions > 0 ? ` \u00b7 ${work.exceptions} need attention` : ""}
                  {work.openCriticalAlerts > 0 ? ` \u00b7 ${work.openCriticalAlerts} critical alert${work.openCriticalAlerts === 1 ? "" : "s"}` : ""}
                </>
              ) : "Queue counts did not load — open the workstation"}
            </p>
          </Link>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Paid Orders</p>
            <p className="mt-2 text-2xl font-semibold text-white">{figure(revenueMetricsRead, (m) => String(m.totalPaidOrders))}</p>
            <p className="mt-1 text-[11px] text-zinc-500">completed sales</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue · 30d</p>
            <p className="mt-2 text-2xl font-semibold text-white">{figure(revenueWindowsRead, (r) => money(r.last30Days))}</p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {revenueWindowsRead.ok
                ? `Today ${money(revenueWindows.today)} · 7d ${money(revenueWindows.last7Days)} · net of refunds, incl. tax`
                : "Revenue windows did not load"}
            </p>
          </div>
          {canViewProfit(session.role) ? (
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Net Profit · 30d</p>
            <p className={`mt-2 text-2xl font-semibold ${!profitWindowsRead.ok ? "text-zinc-400" : profitWindowsRead.value.last30Days >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
              {figure(profitWindowsRead, (p) => money(p.last30Days))}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {profitWindowsRead.ok
                ? `Today ${money(profitWindowsRead.value.today)} · 7d ${money(profitWindowsRead.value.last7Days)}${profitWindowsRead.value.hasEstimatedCost ? " · incl. estimates" : ""}${profitWindowsRead.value.truncated ? " · incomplete" : ""}`
                : "Profit did not load"}
            </p>
          </div>
          ) : null}
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Published Products</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {figure(productsRead, (list) => String(list.filter((product) => product.isPublished && product.isEnabled && !product.isArchived).length))}
            </p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Pending Partners</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {figure(partnersRead, (list) => String(list.filter((partner) => partner.status === "pending").length))}
            </p>
          </div>
          <Link href="/admin/inventory" className="vl-panel rounded-2xl p-4 transition hover:border-white/25">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Low Stock</p>
            <p className={lowStockRead.ok && lowStockRead.value > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>
              {figure(lowStockRead, String)}
            </p>
          </Link>
          <Link href="/admin/reconciliation" className="vl-panel rounded-2xl p-4 transition hover:border-white/25">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Reconciliation Flags</p>
            {/* "0 flags" is the answer an owner treats as an all-clear on the
                ledger. It must never be what a failed read looks like. */}
            <p className={reconciliationFlagRead.ok && reconciliationFlagRead.value > 0 ? "mt-2 text-2xl font-semibold text-amber-300" : "mt-2 text-2xl font-semibold text-white"}>
              {figure(reconciliationFlagRead, String)}
            </p>
          </Link>
          <AdminLiveMetrics
            initialUnavailable={liveMetricsUnavailable}
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
                // Label carries the qualification as well as the neighbouring
                // Refunds row: the tile is read on its own in screenshots and
                // in the CSV header, where the row beside it is not there.
                ["Gross revenue (before refunds)", money(profitDashboard.lifetime.grossRevenue)],
                // Gross revenue is what was invoiced BEFORE refunds, and fully
                // refunded orders are counted (their COGS, postage and fee are
                // real money the store spent). Without this line beside it, a
                // refunded sale is indistinguishable from a kept one.
                ["Refunds", money(profitDashboard.lifetime.totalRefunds)],
                // "n/a", never "0.0%": a margin is a proportion of revenue, and
                // at or below zero revenue there is none to take a proportion of.
                ["Net margin", percent(profitDashboard.lifetime.netMarginPercent)],
                ["Gross margin", percent(profitDashboard.lifetime.grossMarginPercent)],
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
            {/* "orders that took payment", not "paid orders": the count now
                includes fully refunded ones, whose costs the store really
                bore. Orders that never took a payment are still excluded.

                And whether that count is the WHOLE history is a separate
                question, which admin-profit has always answered and no screen
                used to ask — see ProfitDashboard.truncated. */}
            <p className="mt-3 text-[11px] text-zinc-500">
              Lifetime figures across {profitDashboard.lifetime.orderCount} order{profitDashboard.lifetime.orderCount === 1 ? "" : "s"} that took payment (refunds included)
              {profitDashboard.truncated ? " — and that is a floor: the read stopped before the whole history had been seen." : "."}
            </p>
          </section>
        ) : null}

        <section className="vl-panel rounded-[1.6rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Orders Snapshot</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Recent Orders</h2>
              <p className="mt-2 text-sm text-zinc-400">Latest active orders — abandoned and unpaid checkouts are hidden, the same filter /admin/orders opens on.</p>
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

            {!orderListRead.ok ? (
              <p className="px-3 py-6 text-sm text-rose-200">Recent orders could not be loaded — this is not a statement that there are none.</p>
            ) : orders.length === 0 ? (
              <p className="px-3 py-6 text-sm text-zinc-400">No orders yet.</p>
            ) : null}
          </div>
        </section>

        <AdminControlCenterClient />
      </div>
    </div>
  );
}