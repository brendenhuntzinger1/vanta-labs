import { redirect } from "next/navigation";
import { AdminPartnersClient } from "@/components/admin-partners-client";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getAdminOperationsSummary, getAdminPartnerRows, getPayoutQueue } from "@/lib/partner-portal";
import { listCommissionTierRules } from "@/lib/ambassador-commission";
import { getAmbassadorMarketingResources, getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getFraudReviewRows, getPayoutHistory } from "@/lib/admin-ambassadors";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export const dynamic = "force-dynamic";

export default async function AdminPartnersPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  if (!canManageRefunds(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-zinc-400">
          Your role does not have permission to manage partners. Ask a manager or super admin.
        </div>
      </div>
    );
  }

  const [rows, operations, tiers, ambassadorSettings, fraudRows, payoutHistory, marketingResources] = await Promise.all([
    getAdminPartnerRows({ status: "all" }).catch(() => []),
    getAdminOperationsSummary().catch(() => ({
      liveSalesToday: 0,
      liveSalesMonth: 0,
      newCustomers: 0,
      returningCustomers: 0,
      returningCustomerRate: 0,
      lowStockItems: 0,
      pendingShipments: 0,
      activeCoupons: 0,
      pendingNotifications: 0,
    })),
    listCommissionTierRules().catch(() => []),
    getAmbassadorProgramSettings().catch(() => ({
      minimumQualifyingOrder: 0,
      minimumPayoutThreshold: 0,
      commissionHoldDays: 0,
    })),
    getFraudReviewRows().catch(() => []),
    getPayoutHistory().catch(() => []),
    getAmbassadorMarketingResources().catch(() => []),
  ]);

  const payoutQueue = await getPayoutQueue().catch(() => ({ rows: [], readyCount: 0, totalOwed: 0, minimumPayoutThreshold: 0 }));

  function formatDate(value: string | null) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
  }
  function methodLabel(method: string | null, handle: string | null) {
    if (!method) return "Not set";
    const label = method === "paypal" ? "PayPal" : method === "venmo" ? "Venmo" : method === "cashapp" ? "Cash App" : method;
    return handle ? `${label} · ${handle}` : label;
  }

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Partner Operations</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Approve or disable partners, tune commission percentages, review live performance, and export payout records.
          </p>
          {payoutQueue.readyCount > 0 ? (
            <a
              href="#payout-queue"
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/20"
            >
              🔔 {payoutQueue.readyCount} ambassador{payoutQueue.readyCount === 1 ? " is" : "s are"} ready for payout
            </a>
          ) : null}
        </section>

        <section id="payout-queue" className="vl-panel rounded-2xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">Payout Queue</h2>
            <p className="text-xs text-zinc-400">
              {currency(payoutQueue.totalOwed)} owed · min payout {currency(payoutQueue.minimumPayoutThreshold)}
            </p>
          </div>
          {payoutQueue.rows.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No commissions have cleared the hold period yet. Approved commissions appear here, ready to pay.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                    <th className="py-2 pr-4">Ambassador</th>
                    <th className="py-2 pr-4">Amount owed</th>
                    <th className="py-2 pr-4">Approved orders</th>
                    <th className="py-2 pr-4">Payout method</th>
                    <th className="py-2 pr-4">Eligible since</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {payoutQueue.rows.map((row) => (
                    <tr key={row.partnerId} className="border-t border-white/10">
                      <td className="py-2 pr-4 font-medium text-white">{row.name}</td>
                      <td className="py-2 pr-4">{currency(row.amountOwed)}</td>
                      <td className="py-2 pr-4">{row.approvedOrderCount}</td>
                      <td className={`py-2 pr-4 ${row.payoutMethod ? "" : "text-amber-300"}`}>{methodLabel(row.payoutMethod, row.payoutHandle)}</td>
                      <td className="py-2 pr-4">{formatDate(row.eligibleSince)}</td>
                      <td className="py-2 pr-4">
                        {row.meetsMinimum ? (
                          <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">Ready</span>
                        ) : (
                          <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-zinc-400">Below min</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-zinc-500">Use each partner&apos;s <span className="text-zinc-300">Mark Paid</span> action in the table below to complete a payout; the ambassador is emailed a confirmation automatically.</p>
            </div>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Sales Today</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(operations.liveSalesToday)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Sales This Month</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(operations.liveSalesMonth)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Customers</p>
            <p className="mt-2 text-sm text-zinc-300">New: {operations.newCustomers}</p>
            <p className="text-sm text-zinc-300">Returning: {operations.returningCustomers} ({operations.returningCustomerRate.toFixed(1)}%)</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Ops Queue</p>
            <p className="mt-2 text-sm text-zinc-300">Low stock: {operations.lowStockItems}</p>
            <p className="text-sm text-zinc-300">Pending shipments: {operations.pendingShipments}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Marketing</p>
            <p className="mt-2 text-sm text-zinc-300">Active coupons: {operations.activeCoupons}</p>
            <p className="text-sm text-zinc-300">Pending emails: {operations.pendingNotifications}</p>
          </div>
        </section>

        <AdminPartnersClient
          initialRows={rows}
          initialTiers={tiers}
          initialSettings={ambassadorSettings}
          initialFraudRows={fraudRows}
          initialPayoutHistory={payoutHistory}
          initialMarketingResources={marketingResources}
        />
      </div>
    </div>
  );
}
