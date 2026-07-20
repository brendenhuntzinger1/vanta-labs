import { SiteHeader } from "@/components/site-header";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getActiveMembershipTiers } from "@/lib/membership";
import { MembershipLanding } from "@/components/membership-landing";

export const dynamic = "force-dynamic";

export default async function MembershipPage() {
  const [tiers, user] = await Promise.all([
    getActiveMembershipTiers(),
    getAuthenticatedUser(),
  ]);

  const isSignedInCustomer = Boolean(user && detectRoleFromUser(user) === "customer");

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)]">
      <SiteHeader />
      <MembershipLanding tiers={tiers} isSignedInCustomer={isSignedInCustomer} />
    </div>
  );
}
