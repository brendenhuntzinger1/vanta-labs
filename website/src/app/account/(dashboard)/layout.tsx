import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { AccountDashboardNav } from "@/components/account-dashboard-nav";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getApprovedPartnerByAuthUserId } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

export default async function AccountDashboardLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();

  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  // Server-side check: only a customer with an APPROVED ambassador profile
  // gets the Ambassador entry. This is authoritative — never a client flag.
  const approvedAmbassador = await getApprovedPartnerByAuthUserId(user.id).catch(() => null);

  const fullName = (user.user_metadata?.full_name as string | undefined)?.trim() || "";
  const firstName = fullName ? fullName.split(/\s+/)[0] : "";
  // The badge shown in the sidebar and mobile nav on every account page.
  //
  // This used to render the buyer's PAID tier name when their plan was active,
  // and fall back to "Research Member" otherwise. Paid tiers were removed on
  // 2026-09-12, so the fallback is now the only outcome — which is exactly what
  // every non-paying customer already saw, so nothing changes on screen. It is
  // a constant rather than a read of the free tier's row because it is a label,
  // not a setting, and it does not deserve a database round-trip on every
  // account page render.
  const tierName = "Research Member";

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      {/* pt clears the fixed header; pb clears the mobile bottom nav */}
      <div className="mx-auto max-w-6xl px-4 pt-24 pb-28 sm:px-6 lg:px-8 lg:pt-28 lg:pb-12">
        <div className="lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-8">
          <AccountDashboardNav name={firstName || fullName} tierName={tierName} isAmbassador={Boolean(approvedAmbassador)} />
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
