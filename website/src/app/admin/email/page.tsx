import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { getEmailDashboard } from "@/lib/admin-email";
import { loadAutomations } from "@/lib/email/automations";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { CAMPAIGN_SEGMENTS } from "@/lib/email/audience";
import { AdminEmailClient } from "@/components/admin-email-client";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

async function loadCategories(): Promise<string[]> {
  try {
    const { data } = await supabaseAdmin.from("products").select("category").not("category", "is", null);
    const categories = new Set((data ?? []).map((row) => String(row.category ?? "")).filter(Boolean));
    return Array.from(categories).sort();
  } catch {
    return [];
  }
}

export default async function AdminEmailPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canManage = canManageEmailCampaigns(session.role);

  // Every load is independently fault-tolerant: a campaign system that can't
  // render because one query failed is worse than one showing partial data.
  const [dashboard, automations, emailSettings, categories] = canManage
    ? await Promise.all([
        getEmailDashboard().catch(() => ({ subscribers: 0, campaigns: [], totals: { sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 } })),
        loadAutomations().catch(() => []),
        getEmailAdminSettings().catch(() => null),
        loadCategories(),
      ])
    : [{ subscribers: 0, campaigns: [], totals: { sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 } }, [], null, []];

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Email Marketing</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Compose a campaign, pick who receives it, and send. Only customers who opted into marketing are ever
            included, and anyone who unsubscribes is removed automatically — order receipts and shipping notices
            are unaffected either way.
          </p>
        </section>

        {canManage ? (
          <AdminEmailClient
            dashboard={dashboard}
            automations={automations}
            segments={CAMPAIGN_SEGMENTS}
            categories={categories}
            postalAddressSet={Boolean(emailSettings?.marketingPostalAddress)}
            emailReady={emailSettings?.ready ?? false}
            emailEnabled={emailSettings?.enabled ?? false}
          />
        ) : (
          <section className="vl-panel rounded-[1.8rem] p-6">
            <p className="text-sm text-zinc-400">Your role does not have permission to manage email campaigns.</p>
          </section>
        )}
      </div>
    </div>
  );
}
