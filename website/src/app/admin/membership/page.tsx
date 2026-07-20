import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { getMembershipAnalytics, listMembershipTiersAdmin, listPromotionalEvents, getBulkSavingsStats } from "@/lib/admin-membership";
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

  const [tiers, events, analytics, bonusSettings, bulkSavingsConfig, bulkSavingsStats] = canManage
    ? await Promise.all([
        listMembershipTiersAdmin(),
        listPromotionalEvents(),
        getMembershipAnalytics(),
        getMembershipBonusSettings(),
        getBulkSavingsControlConfig(),
        getBulkSavingsStats(),
      ])
    : [[], [], null, null, null, null];

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
      </div>
    </div>
  );
}
