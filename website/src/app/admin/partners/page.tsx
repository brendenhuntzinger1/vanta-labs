import { redirect } from "next/navigation";
import { AdminPartnersClient } from "@/components/admin-partners-client";
import { getReferralProgramConfig } from "@/lib/admin-control";
import {
  DEFAULT_COMMISSION_HOLD_DAYS,
  DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
  DEFAULT_MINIMUM_QUALIFYING_ORDER,
} from "@/lib/referral-config";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getAdminOperationsSummary, getAdminPartnerRows, getPayoutQueue } from "@/lib/partner-portal";
import { listCommissionTierRules } from "@/lib/ambassador-commission";
import { getAmbassadorMarketingResources, getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getFraudReviewRows, getPayoutHistory } from "@/lib/admin-ambassadors";
import { failedReads, settleRead, UNKNOWN_FIGURE } from "@/lib/admin-read";
import { AdminReadFailureNotice } from "@/components/admin-data-notices";
import { AdminRecordPayoutButton } from "@/components/admin-record-payout-dialog";
import { formatDisplayDate } from "@/lib/format-date";
import { describePayoutDestination } from "@/lib/payout-channels";

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

  const [rows, operations, tiers, ambassadorSettings, fraudRows, payoutHistory, marketingResources, referralProgram] = await Promise.all([
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
    // Fall back to the REAL defaults, never to zero. A transient read error
    // used to render "minimum qualifying order: 0" as though it were policy --
    // and with an explicit Save button on the field, an owner could persist
    // that zero and destroy their $100 minimum from a blip.
    getAmbassadorProgramSettings().catch(() => ({
      minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
      minimumPayoutThreshold: DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
      commissionHoldDays: DEFAULT_COMMISSION_HOLD_DAYS,
      stored: { minimumQualifyingOrder: false, minimumPayoutThreshold: false, commissionHoldDays: false },
    })),
    getFraudReviewRows().catch(() => []),
    getPayoutHistory().catch(() => []),
    getAmbassadorMarketingResources().catch(() => []),
    getReferralProgramConfig(),
  ]);

  // A FAILED READ IS NOT "$0 owed" — see admin-read.ts. The empty fallback
  // rendered "$0.00 owed" and "No commissions have cleared the hold period yet"
  // over a database that did not answer, which is exactly the reading an owner
  // acts on by paying nobody.
  const payoutQueueRead = await settleRead("Payout queue", getPayoutQueue);
  const payoutQueue = payoutQueueRead.ok
    ? payoutQueueRead.value
    : { rows: [], readyCount: 0, totalOwed: 0, minimumPayoutThreshold: 0 };

  function formatDate(value: string | null) {
    if (!value) return "—";
    const d = new Date(value);
    return formatDisplayDate(d, "medium") ?? "—";
  }
  // The roster row for a queue entry: the queue knows what has cleared the
  // hold, the roster knows what is still inside it and the ambassador's status.
  const rowById = new Map(rows.map((row) => [row.id, row]));

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
              {payoutQueueRead.ok
                ? `${currency(payoutQueue.totalOwed)} owed · min payout ${currency(payoutQueue.minimumPayoutThreshold)}`
                : `${UNKNOWN_FIGURE} owed (could not be loaded)`}
            </p>
          </div>
          {!payoutQueueRead.ok ? (
            <div className="mt-4">
              <AdminReadFailureNotice failures={failedReads([payoutQueueRead])} />
            </div>
          ) : payoutQueue.rows.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              No commissions have cleared the hold period yet. Approved commissions appear here, ready to pay.
              Already paid someone whose commission is still in the {ambassadorSettings.commissionHoldDays}-day hold? Use <span className="text-zinc-300">Mark Paid</span> on their row in the Ambassadors tab below — it can release the held balance early.
            </p>
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
                    <th className="py-2 pr-4">Action</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {payoutQueue.rows.map((row) => {
                    const roster = rowById.get(row.partnerId);
                    return (
                      <tr key={row.partnerId} className="border-t border-white/10">
                        <td className="py-2 pr-4 font-medium text-white">
                          <a href={`/admin/partners/${row.partnerId}`} className="hover:text-cyan-200">{row.name}</a>
                        </td>
                        <td className="py-2 pr-4">{currency(row.amountOwed)}</td>
                        <td className="py-2 pr-4">{row.approvedOrderCount}</td>
                        <td className={`py-2 pr-4 ${row.payoutMethod ? "" : "text-amber-300"}`}>{describePayoutDestination(row.payoutMethod, row.payoutHandle) ?? "Not set"}</td>
                        <td className="py-2 pr-4">{formatDate(row.eligibleSince)}</td>
                        <td className="py-2 pr-4">
                          {row.onHold ? (
                            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200">Not approved</span>
                          ) : row.meetsMinimum ? (
                            <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">Ready</span>
                          ) : (
                            <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-zinc-400">Below min</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          <AdminRecordPayoutButton
                            target={{
                              id: row.partnerId,
                              name: row.name,
                              referralCode: roster?.referralCode ?? "",
                              status: roster?.status ?? (row.onHold ? "disabled" : "approved"),
                              payoutMethod: row.payoutMethod,
                              payoutHandle: row.payoutHandle,
                              readyAmount: row.amountOwed,
                              heldAmount: roster?.pendingCommissions ?? 0,
                            }}
                            minimumPayoutThreshold={ambassadorSettings.minimumPayoutThreshold}
                            commissionHoldDays={ambassadorSettings.commissionHoldDays}
                          >
                            Mark Paid
                          </AdminRecordPayoutButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-zinc-500">
                <span className="text-zinc-300">Mark Paid</span> records money you have already sent and emails the ambassador a confirmation.
                An ambassador whose commission is still inside the {ambassadorSettings.commissionHoldDays}-day hold is not listed here yet — their <span className="text-zinc-300">Mark Paid</span> in the Ambassadors tab below can release it early.
              </p>
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
          programDefaultDiscountPercent={referralProgram.discountPercent}
          programDefaultCommissionPercent={referralProgram.defaultCommissionPercent}
        />
      </div>
    </div>
  );
}
