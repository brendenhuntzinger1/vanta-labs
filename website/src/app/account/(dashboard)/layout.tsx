import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { AccountNav } from "@/components/account-nav";
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
  // gets the Ambassador Stats tab. This is authoritative — the tab is never
  // shown based on a client-only flag.
  const approvedAmbassador = await getApprovedPartnerByAuthUserId(user.id).catch(() => null);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <div className="mx-auto max-w-5xl px-4 pb-8 pt-28 sm:px-6 lg:px-8">
        <AccountNav showAmbassadorTab={Boolean(approvedAmbassador)} />
        {children}
      </div>
    </div>
  );
}
