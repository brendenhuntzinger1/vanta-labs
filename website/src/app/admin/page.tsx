import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getCurrentOnlineVisitorCount, getRevenueWindowMetrics } from "@/lib/admin-analytics";
import { getAdminOrderRows } from "@/lib/admin-orders";
import { listAdminProducts } from "@/lib/admin-products";
import { getLowStockCount } from "@/lib/admin-inventory";
import { getReconciliationFlagCount } from "@/lib/admin-reconciliation";
import { getAdminPartnerRows } from "@/lib/partner-portal";
import { AdminControlCenterClient } from "@/components/admin-control-center-client";
import { AdminLiveMetrics } from "@/components/admin-live-metrics";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function isPaidStatus(value: string | null | undefined) {
  const status = String(value ?? "").toLowerCase();
  return status === "paid" || status === "completed" || status === "succeeded";
}

export default async function AdminHomePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const [orderList, products, partners, onlineVisitors, revenueWindows, lowStockCount, reconciliationFlagCount] = await Promise.all([
    getAdminOrderRows({ pageSize: 1000 }).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 1000, pageCount: 1 })),
    listAdminProducts({ search: "", category: "all", status: "all" }).catch(() => []),
    getAdminPartnerRows({ status: "all" }).catch(() => []),
    getCurrentOnlineVisitorCount().catch(() => 0),
    getRevenueWindowMetrics().catch(() => ({ today: 0, last7Days: 0, last30Days: 0 })),
    getLowStockCount().catch(() => 0),
    getReconciliationFlagCount().catch(() => 0),
  ]);

  const orders = orderList.rows;
  const totalRevenue = orders
    .filter((row) => isPaidStatus(row.payment_status))
    .reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0);
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
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Orders</p>
            <p className="mt-2 text-2xl font-semibold text-white">{orderList.total}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(totalRevenue)}</p>
          </div>
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