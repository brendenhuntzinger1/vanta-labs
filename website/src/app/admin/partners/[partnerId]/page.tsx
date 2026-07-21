import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getAdminPartnerRows, getPartnerSummary } from "@/lib/partner-portal";
import { getAmbassadorRefundedOrderCount, getPayoutHistory } from "@/lib/admin-ambassadors";
import { getSiteUrl } from "@/lib/env";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_STYLES: Record<string, string> = {
  approved: "border-emerald-400/40 text-emerald-200",
  pending: "border-amber-400/40 text-amber-200",
  info_requested: "border-sky-400/40 text-sky-200",
  disabled: "border-zinc-500/40 text-zinc-300",
  rejected: "border-rose-400/40 text-rose-200",
};

export const dynamic = "force-dynamic";

export default async function AdminAmbassadorProfilePage({ params }: { params: Promise<{ partnerId: string }> }) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  if (!canManageRefunds(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-zinc-400">
          Your role does not have permission to view ambassador profiles. Ask a manager or super admin.
        </div>
      </div>
    );
  }

  const { partnerId } = await params;
  const siteUrl = getSiteUrl();

  const [rows, payoutHistory, refundedOrders] = await Promise.all([
    getAdminPartnerRows({ status: "all" }).catch(() => []),
    getPayoutHistory(200).catch(() => []),
    getAmbassadorRefundedOrderCount(partnerId).catch(() => 0),
  ]);

  const row = rows.find((r) => r.id === partnerId);
  if (!row) {
    notFound();
  }

  const summary = await getPartnerSummary(partnerId, siteUrl).catch(() => null);
  const payments = payoutHistory.filter((p) => p.ambassadorId === partnerId);
  const referralLink = `${siteUrl}/r/${row.referralCode}`;
  const balanceOwed = row.pendingCommissions + row.approvedForPayoutCommissions;
  const averageOrderValue = summary?.averageOrderValue ?? (row.totalOrders > 0 ? row.totalRevenue / row.totalOrders : 0);
  const monthlySeries = summary?.monthlyRevenueSeries ?? [];
  const maxMonthly = monthlySeries.reduce((max, point) => Math.max(max, point.value), 0);
  const statusBadge = STATUS_STYLES[row.status] ?? "border-zinc-500/40 text-zinc-300";

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <Link href="/admin/partners" className="text-xs uppercase tracking-[0.22em] text-cyan-300/80 hover:text-cyan-200">
          ← Back to Partner Operations
        </Link>

        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Ambassador Profile</p>
              <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">{row.name}</h1>
              <p className="mt-1 text-sm text-zinc-400">{row.email ?? "No email on file"}</p>
            </div>
            <span className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.18em] ${statusBadge}`}>
              {row.status.replace(/_/g, " ")}
            </span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Referral Code</p>
              <p className="mt-1 font-mono text-lg text-white">{row.referralCode}</p>
            </div>
            <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Referral Link</p>
              <a href={referralLink} className="mt-1 block truncate font-mono text-sm text-cyan-300 hover:text-cyan-200" target="_blank" rel="noreferrer">
                {referralLink}
              </a>
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Commission rate:{" "}
            {row.commissionPercentLocked
              ? <span className="text-amber-300">{row.commissionPercent}% (manual — auto tiers off)</span>
              : <span className="text-emerald-300">Auto performance tiers active</span>}
            {" · "}Manage status, code, and payouts from{" "}
            <Link href="/admin/partners" className="text-cyan-300 hover:text-cyan-200">Partner Operations</Link>.
          </p>
        </section>

        <section className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Gross Sales</p>
            <p className="mt-2 text-xl font-semibold text-white">{currency(row.totalRevenue)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Orders</p>
            <p className="mt-2 text-xl font-semibold text-white">{row.totalOrders}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Avg Order Value</p>
            <p className="mt-2 text-xl font-semibold text-white">{currency(averageOrderValue)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Clicks</p>
            <p className="mt-2 text-xl font-semibold text-white">{row.clicks}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Conversion</p>
            <p className="mt-2 text-xl font-semibold text-white">{row.conversionRate.toFixed(1)}%</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Refunded Orders</p>
            <p className="mt-2 text-xl font-semibold text-zinc-300">{refundedOrders}</p>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Net Commission Earned</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(row.totalCommissions)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Commission Paid</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(row.paidCommissions)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Balance Owed</p>
            <p className="mt-2 text-2xl font-semibold text-cyan-300">{currency(balanceOwed)}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{currency(row.approvedForPayoutCommissions)} ready · {currency(row.pendingCommissions)} holding</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Reversed</p>
            <p className="mt-2 text-2xl font-semibold text-zinc-400">{currency(row.reversedCommissions)}</p>
          </div>
        </section>

        {monthlySeries.length > 0 && maxMonthly > 0 ? (
          <section className="vl-panel rounded-2xl p-4 sm:p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Monthly Sales Trend</h2>
            <div className="mt-4 flex items-end gap-2" style={{ height: "120px" }}>
              {monthlySeries.map((point) => (
                <div key={point.label} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className="w-full rounded-t bg-cyan-500/40"
                    style={{ height: `${maxMonthly > 0 ? Math.max(2, (point.value / maxMonthly) * 100) : 0}%` }}
                    title={`${point.label}: ${currency(point.value)}`}
                  />
                  <span className="text-[10px] text-zinc-500">{point.label}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="vl-panel rounded-2xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Payment History</h2>
          {payments.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No payouts recorded for this ambassador yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="px-2 py-2">Date Paid</th>
                    <th className="px-2 py-2">Amount</th>
                    <th className="px-2 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id} className="border-t border-zinc-800/70 text-zinc-200">
                      <td className="px-2 py-2">{formatDate(payment.createdAt)}</td>
                      <td className="px-2 py-2 font-semibold text-white">{currency(payment.amount)}</td>
                      <td className="px-2 py-2 text-zinc-400">{payment.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="vl-panel rounded-2xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Recent Activity</h2>
          {!summary || summary.recentOrders.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No referral orders yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Customer</th>
                    <th className="px-2 py-2">Order</th>
                    <th className="px-2 py-2">Commission</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recentOrders.map((order) => (
                    <tr key={order.orderId} className="border-t border-zinc-800/70 text-zinc-200">
                      <td className="px-2 py-2">{formatDate(order.createdAt)}</td>
                      <td className="px-2 py-2 text-zinc-400">{order.customerEmail ?? "—"}</td>
                      <td className="px-2 py-2">{currency(order.amountPaid)}</td>
                      <td className="px-2 py-2">{currency(order.commissionAmount)}</td>
                      <td className="px-2 py-2 text-xs text-zinc-400">{order.commissionStatus.replace(/_/g, " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
