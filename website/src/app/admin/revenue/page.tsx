import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canViewProfit } from "@/lib/admin-roles";
import { getRevenueMetrics } from "@/lib/admin-revenue";
import { getProfitWindowMetrics } from "@/lib/admin-profit";
import { getSalesTaxReport } from "@/lib/admin-tax-report";
import { failedReads, figure, settleRead } from "@/lib/admin-read";
import { AdminReadFailureNotice, AdminTruncationNotice } from "@/components/admin-data-notices";

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

  // EVERY READ ON THIS PAGE IS CARRIED AS AN OUTCOME, NOT AS A VALUE.
  //
  // These three used to be `.catch(() => zeros)` / `.catch(() => null)`, which
  // rendered a database outage as "Today's Revenue $0.00 · 0 orders today" and
  // "No sales tax collected yet" — the exact screen a healthy quiet Tuesday
  // produces. See admin-read.ts.
  const metricsRead = await settleRead("Revenue metrics", getRevenueMetrics);
  // COGS/margin is manager+ only — staff sees revenue, never profit.
  const showProfit = canViewProfit(session.role);
  const profitRead = showProfit ? await settleRead("Net profit", getProfitWindowMetrics) : null;
  // Sales tax collected per destination state (for filing). Never blocks the
  // dashboard if the query fails — but never claims a clean filing either.
  const taxRead = await settleRead("Sales tax report", getSalesTaxReport);

  const metrics = metricsRead.ok ? metricsRead.value : null;
  const profit = profitRead?.ok ? profitRead.value : null;
  const taxReport = taxRead.ok ? taxRead.value : null;

  const failures = failedReads([metricsRead, ...(profitRead ? [profitRead] : []), taxRead]);
  const maxMethodRevenue = Math.max(1, ...(metrics?.byMethod ?? []).map((m) => m.revenue));

  // The `truncated` flags these modules have always computed, finally rendered.
  // A tax filing assembled from part of the year, presented as the year, is the
  // worst case this notice exists for.
  const truncatedSources = [
    ...(profit?.truncated ? ["the net-profit windows"] : []),
    ...(taxReport?.truncated ? ["the sales-tax filing report"] : []),
  ];

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

        {failures.length > 0 ? (
          <div className="mt-6">
            <AdminReadFailureNotice failures={failures} />
          </div>
        ) : null}

        {truncatedSources.length > 0 ? (
          <div className="mt-3">
            <AdminTruncationNotice
              sources={truncatedSources}
              detail="Narrow the report by year, or raise the read ceiling, before filing or reporting anything from this screen."
            />
          </div>
        ) : null}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Today's Revenue"
            value={figure(metricsRead, (m) => money(m.todayRevenue))}
            sub={metrics ? `${metrics.todayOrders} order${metrics.todayOrders === 1 ? "" : "s"} today` : "Not loaded"}
            accent
          />
          <StatCard
            label="Total Paid Revenue"
            value={figure(metricsRead, (m) => money(m.totalPaidRevenue))}
            sub={metrics ? `${metrics.totalPaidOrders} paid orders` : "Not loaded"}
          />
          <StatCard label="Average Order Value" value={figure(metricsRead, (m) => money(m.averageOrderValue))} />
          <StatCard
            label="Processing Fees Collected"
            value={figure(metricsRead, (m) => money(m.processingFeesCollected))}
            sub="Card fees added at checkout"
          />
        </div>

        {profitRead ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Net Profit · Today" value={figure(profitRead, (p) => money(p.today))} sub="After cost, commission, fees, shipping" accent />
          <StatCard label="Net Profit · 7 days" value={figure(profitRead, (p) => money(p.last7Days))} />
          <StatCard
            label="Net Profit · 30 days"
            value={figure(profitRead, (p) => money(p.last30Days))}
            sub={profit
              ? `${profit.ordersLast30Days} paid order${profit.ordersLast30Days === 1 ? "" : "s"}${profit.hasEstimatedCost ? " · incl. estimates" : ""}${profit.truncated ? " · incomplete" : ""}`
              : "Not loaded"}
          />
          <StatCard
            label="Avg Profit / Order · 30d"
            value={figure(profitRead, (p) => money(p.ordersLast30Days > 0 ? p.last30Days / p.ordersLast30Days : 0))}
          />
        </div>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Pending Payments" value={figure(metricsRead, (m) => String(m.pendingPayments))} sub="Awaiting customer / verification" />
          <StatCard label="Approved Payments" value={figure(metricsRead, (m) => String(m.approvedPayments))} />
          <StatCard label="Awaiting Fulfillment" value={figure(metricsRead, (m) => String(m.awaitingFulfillment))} />
          <StatCard label="Orders Shipped" value={figure(metricsRead, (m) => String(m.shipped))} />
        </div>

        <div className="vl-panel mt-6 rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold">Revenue by Payment Method</h2>
          {!metrics ? (
            /* NOT "No paid orders yet." An unread breakdown and an empty one are
               different facts about the store. */
            <p className="mt-3 text-sm text-rose-200">Payment mix could not be loaded — this is not a statement that there were no sales.</p>
          ) : metrics.byMethod.length === 0 ? (
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

        <div className="vl-panel mt-6 rounded-2xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Sales Tax Collected by State</h2>
              <p className="mt-1 text-xs text-zinc-500">Address-based tax recorded on each paid order — these are the figures you remit to each state.</p>
            </div>
            <a href="/api/admin/tax/export" className="vl-btn-secondary inline-flex px-4 py-2 text-xs" download>Export CSV</a>
          </div>
          {!taxReport ? (
            /* A FILING REPORT MUST NEVER SAY "NOTHING TO REMIT" ON A FAILED
               READ. This branch used to be shared with the genuinely-empty one
               below, so an unreachable database told the owner they owed no
               state any sales tax. */
            <p className="mt-3 text-sm text-rose-200">
              The sales tax report could not be loaded. <strong>Do not file from this screen</strong> — this is a failed
              read, not a report that you collected no tax.
            </p>
          ) : taxReport.byState.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">No sales tax collected yet. Tax is charged only on orders shipping to your configured nexus states (Control Center → Sales Tax).</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              {taxReport.truncated ? (
                <p className="mb-3 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
                  <strong>This filing report is incomplete.</strong> More taxed orders exist than this read returned, so
                  every figure below — and the CSV export — understates what you owe.
                </p>
              ) : null}
              <table className="w-full min-w-[540px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                    <th className="pb-2 pr-4">State</th>
                    <th className="pb-2 pr-4">Orders</th>
                    <th className="pb-2 pr-4">Taxable Sales</th>
                    <th className="pb-2 pr-4">Tax Collected</th>
                    <th className="pb-2 pr-4">Tax Refunded</th>
                    <th className="pb-2">Net Tax Due</th>
                  </tr>
                </thead>
                <tbody>
                  {taxReport.byState.map((s) => (
                    <tr key={s.state} className="border-b border-white/5">
                      <td className="py-2 pr-4 font-medium text-zinc-200">{s.state}</td>
                      <td className="py-2 pr-4 text-zinc-300 tabular-nums">{s.orders}</td>
                      <td className="py-2 pr-4 text-zinc-300 tabular-nums">{money(s.taxableSales)}</td>
                      <td className="py-2 pr-4 text-zinc-300 tabular-nums">{money(s.taxCollected)}</td>
                      <td className="py-2 pr-4 text-zinc-300 tabular-nums">{s.taxRefunded > 0 ? money(s.taxRefunded) : "—"}</td>
                      <td className="py-2 font-semibold text-white tabular-nums">{money(s.netTax)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="pt-2 font-semibold text-zinc-200">{taxReport.truncated ? "Total (partial)" : "Total"}</td>
                    <td className="pt-2 text-zinc-300 tabular-nums">{taxReport.totals.orders}</td>
                    <td className="pt-2" />
                    <td className="pt-2 font-semibold text-white tabular-nums">{money(taxReport.totals.taxCollected)}</td>
                    <td className="pt-2 text-zinc-300 tabular-nums">{taxReport.totals.taxRefunded > 0 ? money(taxReport.totals.taxRefunded) : "—"}</td>
                    <td className="pt-2 font-semibold text-white tabular-nums">{money(taxReport.totals.netTax)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
