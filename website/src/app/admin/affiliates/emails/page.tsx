import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { getAffiliateEmailDashboard } from "@/lib/admin-affiliate-email";
import { AdminAffiliateEmailClient } from "@/components/admin-affiliate-email-client";

export const dynamic = "force-dynamic";

export default async function AdminAffiliateEmailsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageEmailCampaigns(session.role);

  // Fault-tolerant, like every other admin load here: a page that cannot render
  // because one report query failed is worse than one showing partial data.
  const dashboard = canManage
    ? await getAffiliateEmailDashboard().catch(() => ({
        activeAffiliates: 0,
        campaigns: [],
        totals: { sent: 0, opened: 0, clicked: 0, failed: 0 },
      }))
    : { activeAffiliates: 0, campaigns: [], totals: { sent: 0, opened: 0, clicked: 0, failed: 0 } };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">
            <Link href="/admin/partners" className="hover:text-zinc-300">Affiliates</Link> · Emails
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">Email your affiliates</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Write once, and every affiliate gets their own copy with their own referral code, link and commission rate filled in.
            Drafts, previews and test sends are free; an actual send always asks first.
          </p>
        </header>

        <AdminAffiliateEmailClient dashboard={dashboard} canManage={canManage} />
      </div>
    </div>
  );
}
