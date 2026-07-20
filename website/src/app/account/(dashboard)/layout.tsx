import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { AccountNav } from "@/components/account-nav";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export default async function AccountDashboardLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();

  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <div className="mx-auto max-w-5xl px-4 pb-8 pt-28 sm:px-6 lg:px-8">
        <AccountNav />
        {children}
      </div>
    </div>
  );
}
