import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageCartRecovery } from "@/lib/admin-roles";
import { listAbandonedCarts, getCartRecoveryStats, getCartRecoveryTrend } from "@/lib/admin-cart-recovery";
import { getCartRecoveryControlConfig } from "@/lib/admin-control";
import { AdminCartRecoveryClient } from "@/components/admin-cart-recovery-client";

export const dynamic = "force-dynamic";

export default async function AdminCartRecoveryPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageCartRecovery(session.role);

  const [carts, stats, weeklyTrend, monthlyTrend, config] = canManage
    ? await Promise.all([
        listAbandonedCarts(),
        getCartRecoveryStats(),
        getCartRecoveryTrend(7),
        getCartRecoveryTrend(30),
        getCartRecoveryControlConfig(),
      ])
    : [[], null, [], [], null];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Abandoned Cart Recovery</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Fully automated - a scheduled sweep detects abandoned carts and sends the 30-minute / 12-hour /
            24-hour / 72-hour recovery sequence with zero manual work, stopping the moment a customer completes
            checkout.
          </p>
        </section>

        {canManage && stats && config ? (
          <AdminCartRecoveryClient
            initialCarts={carts}
            initialStats={stats}
            initialWeeklyTrend={weeklyTrend}
            initialMonthlyTrend={monthlyTrend}
            initialConfig={config}
          />
        ) : (
          <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to manage cart recovery.
          </section>
        )}
      </div>
    </div>
  );
}
