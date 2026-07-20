import { SiteHeaderV2 } from "@/components/site-header-v2";
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
    <div className="vl2-galaxy min-h-screen text-white">
      <SiteHeaderV2 />
      <MembershipLanding tiers={tiers} isSignedInCustomer={isSignedInCustomer} />
    </div>
  );
}
