import { redirect } from "next/navigation";
import { PartnerDashboardClient } from "@/components/partner-dashboard-client";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getPartnerByAuthUserId, getPartnerSummary } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

export default async function PartnerDashboardPage() {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/partner/login");
  }

  const role = detectRoleFromUser(user);
  if (role === "admin") {
    redirect("/admin/partners");
  }

  if (role !== "partner") {
    redirect("/partner/login");
  }

  const partner = await getPartnerByAuthUserId(user.id);
  if (!partner) {
    redirect("/partner/login");
  }

  if (partner.status !== "approved") {
    redirect("/partner/pending");
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const summary = await getPartnerSummary(partner.id, siteUrl);

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.09),transparent_55%),linear-gradient(160deg,#04060f_0%,#0b1120_45%,#050810_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <PartnerDashboardClient summary={summary} />
      </div>
    </div>
  );
}
