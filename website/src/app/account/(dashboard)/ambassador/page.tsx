import { redirect } from "next/navigation";
import { PartnerDashboardClient } from "@/components/partner-dashboard-client";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { getApprovedPartnerByAuthUserId, getPartnerByAuthUserId, getPartnerSummary } from "@/lib/partner-portal";

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
    // TWO DIFFERENT "NO" ANSWERS, and they must not be given the same reply.
    //
    // Someone who never applied gets nothing — bouncing them to /account is
    // correct, and telling them anything would leak that the programme has
    // states at all.
    //
    // Someone who DID apply and is waiting was getting that same silent bounce.
    // They sign in, look for the ambassador area, and land back on their
    // account with no explanation — including the applicant we have explicitly
    // asked for more information, who has no way to learn that we are waiting
    // on them. /partner/pending exists to say exactly this, with copy for
    // pending, info_requested, rejected and disabled, and nothing in the
    // application routed to it.
    const application = await getPartnerByAuthUserId(user.id);
    redirect(application ? "/partner/pending" : "/account");
  }

  const summary = await getPartnerSummary(partner.id, getSiteUrl());

  return <PartnerDashboardClient summary={summary} />;
}
