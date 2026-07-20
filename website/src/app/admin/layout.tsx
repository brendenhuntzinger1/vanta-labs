import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { AdminTabs } from "@/components/admin-tabs";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="px-4 pt-6 sm:px-6 lg:px-8">
        <AdminTabs />
      </div>
      {children}
    </div>
  );
}
