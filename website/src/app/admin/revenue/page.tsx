import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getRevenueMetrics } from "@/lib/admin-revenue";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? "border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)]" : "border-white/10 bg-white/[0.02]"}`}>
      <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-400">{label}</p>
      <p className={`mt-2 text-2xl font-semibold sm:text-3xl ${accent ? "text-[color:var(--accent-gold)]" : "text-white"}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
    </div>
  );
}

export default async function AdminRevenuePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const metrics = await getRevenueMetrics().catch(() => ({
    todayRevenue: 0,
    todayOrders: 0,
    totalPaidRevenue: 0,
    totalPaidOrders: 0,
    averageOrderValue: 0,
    processingFeesCollected: 0,
    pendingPayments: 0,
    approvedPayments: 0,
    awaitingFulfillment: 0,
    shipped: 0,
    byMethod: [],
  }));
  const maxMethodRevenue = Math.max(1, ...metrics.byMethod.map((m) => m.revenue));

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Business Dashboard</h1>
            <p className="mt-2 text-sm text-zinc-400">Revenue, payment mix, and the fulfillment pipeline at a glance.</p>
          </div>
          <div className="flex gap-2">
            <Link href="/admin/payments" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">Payments</Link>
            <Link href="/admin/fulfillment" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">Fulfillment</Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Today's Revenue" value={money(metrics.todayRevenue)} sub={`${metrics.todayOrders} order${metrics.todayOrders === 1 ? "" : "s"} today`} accent />
          <StatCard label="Total Paid Revenue" value={money(metrics.totalPaidRevenue)} sub={`${metrics.totalPaidOrders} paid orders`} />
          <StatCard label="Average Order Value" value={money(metrics.averageOrderValue)} />
          <StatCard label="Processing Fees Collected" value={money(metrics.processingFeesCollected)} sub="Card fees added at checkout" />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Pending Payments" value={String(metrics.pendingPayments)} sub="Awaiting customer / verification" />
          <StatCard label="Approved Payments" value={String(metrics.approvedPayments)} />
          <StatCard label="Awaiting Fulfillment" value={String(metrics.awaitingFulfillment)} />
          <StatCard label="Orders Shipped" value={String(metrics.shipped)} />
        </div>

        <div className="vl-panel mt-6 rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold">Revenue by Payment Method</h2>
          {metrics.byMethod.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">No paid orders yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {metrics.byMethod.map((row) => (
                <div key={row.method || "unspecified"}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-200">{row.label} <span className="text-zinc-500">· {row.orders} order{row.orders === 1 ? "" : "s"}</span></span>
                    <span className="font-semibold text-white">{money(row.revenue)}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-[color:var(--accent-gold)]"
                      style={{ width: `${Math.max(3, (row.revenue / maxMethodRevenue) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
