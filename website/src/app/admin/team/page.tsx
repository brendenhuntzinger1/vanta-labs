import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageTeam } from "@/lib/admin-roles";
import { listAdminAccounts } from "@/lib/admin-team";
import { AdminTeamClient } from "@/components/admin-team-client";

export const dynamic = "force-dynamic";

export default async function AdminTeamPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageTeam(session.role);
  const accounts = canManage ? await listAdminAccounts().catch(() => []) : [];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Team</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Manage admin accounts and roles. Staff can run day-to-day operations; managers can also issue refunds,
            manage coupons/inventory, and view the audit log; super admins can also manage the team.
          </p>
        </section>

        {canManage ? (
          <AdminTeamClient initialAccounts={accounts} currentUsername={session.username} />
        ) : (
          <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to manage the team.
          </section>
        )}
      </div>
    </div>
  );
}
