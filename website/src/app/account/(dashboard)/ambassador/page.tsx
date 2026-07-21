import { redirect } from "next/navigation";
import { PartnerDashboardClient } from "@/components/partner-dashboard-client";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { getApprovedPartnerByAuthUserId, getPartnerSummary } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

// The "Ambassador Stats" tab. The parent account layout already guarantees a
// signed-in customer; here we additionally require an APPROVED ambassador
// profile for this exact user (defense in depth) before rendering any stats.
// A regular customer who navigates here directly is redirected back to their
// account and never sees ambassador data.
export default async function AccountAmbassadorPage() {
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect("/account/login");
  }

  const partner = await getApprovedPartnerByAuthUserId(user.id);
  if (!partner) {
    redirect("/account");
  }

  const summary = await getPartnerSummary(partner.id, getSiteUrl());

  return <PartnerDashboardClient summary={summary} />;
}
