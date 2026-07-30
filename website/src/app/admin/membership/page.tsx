import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { getMembershipAnalytics, listMembershipTiersAdmin, listPromotionalEvents, getBulkSavingsStats, listMembershipRoster } from "@/lib/admin-membership";
import { getMembershipBonusSettings } from "@/lib/membership";
import { getBulkSavingsControlConfig } from "@/lib/admin-control";
import { AdminMembershipClient } from "@/components/admin-membership-client";

export const dynamic = "force-dynamic";

export default async function AdminMembershipPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageMembership(session.role);

  const [tiers, events, analytics, bonusSettings, bulkSavingsConfig, bulkSavingsStats, roster] = canManage
    ? await Promise.all([
        listMembershipTiersAdmin().catch(() => []),
        listPromotionalEvents().catch(() => []),
        getMembershipAnalytics().catch(() => null),
        getMembershipBonusSettings().catch(() => null),
        getBulkSavingsControlConfig().catch(() => null),
        getBulkSavingsStats().catch(() => null),
        listMembershipRoster().catch(() => []),
      ])
    : [[], [], null, null, null, null, []];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Membership &amp; Rewards</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Manage tiers, intro-offer pricing, points bonuses, promotional events, and customer balances. The
            billing schedule, dates, and dashboard are fully live — a payment processor isn&apos;t connected yet,
            so scheduled charges resolve as &quot;failed&quot; (never faked as successful) until one is. You can
            still activate a member&apos;s tier manually below in the meantime.
          </p>
        </section>

        {canManage && analytics && bonusSettings && bulkSavingsConfig && bulkSavingsStats ? (
          <AdminMembershipClient
            initialTiers={tiers}
            initialEvents={events}
            initialAnalytics={analytics}
            initialBonusSettings={bonusSettings}
            initialBulkSavingsConfig={bulkSavingsConfig}
            initialBulkSavingsStats={bulkSavingsStats}
          />
        ) : (
          <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to manage membership &amp; rewards.
          </section>
        )}

        {canManage ? (
          <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-white">Members ({roster.length})</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Every customer with a membership record — name, email, exact plan, billing, and store credit.
                </p>
              </div>
            </div>
            {roster.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No members yet — new signups appear here automatically.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                    <tr className="border-b border-white/10">
                      <th className="pb-2 pr-4">Member</th>
                      <th className="pb-2 pr-4">Plan</th>
                      <th className="pb-2 pr-4">Billing</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Joined</th>
                      <th className="pb-2 pr-4">Next billing</th>
                      <th className="pb-2">Store credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((member) => (
                      <tr key={member.userId} className="border-b border-white/5">
                        <td className="py-3 pr-4">
                          <p className="font-medium text-zinc-100">{member.name}</p>
                          <p className="text-xs text-zinc-500">{member.email}</p>
                        </td>
                        <td className="py-3 pr-4 text-zinc-200">{member.tierName}</td>
                        <td className="py-3 pr-4 text-zinc-300">{member.billingCycle === "free" ? "—" : member.billingCycle}</td>
                        <td className="py-3 pr-4">
                          <span className={`rounded-full px-2 py-1 text-xs ${
                            member.status === "active" ? "bg-emerald-400/15 text-emerald-300"
                            : member.status === "trialing" ? "bg-cyan-400/15 text-cyan-300"
                            : member.status === "past_due" ? "bg-amber-400/15 text-amber-300"
                            : "bg-zinc-500/15 text-zinc-400"
                          }`}>
                            {member.status.replace("_", " ")}{member.cancelAtPeriodEnd ? " · ending" : ""}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-xs text-zinc-400">{member.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : "—"}</td>
                        <td className="py-3 pr-4 text-xs text-zinc-400">
                          {member.billingCycle === "free" || !member.nextBillingAt
                            ? "—"
                            : `${new Date(member.nextBillingAt).toLocaleDateString()} · $${(member.nextBillingAmountCents / 100).toFixed(2)}`}
                        </td>
                        <td className="py-3 text-zinc-300 tabular-nums">
                          {member.storeCreditCents > 0 ? `$${(member.storeCreditCents / 100).toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
