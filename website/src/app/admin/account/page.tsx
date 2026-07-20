import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { AdminAccountClient } from "@/components/admin-account-client";

export const dynamic = "force-dynamic";

// Any signed-in admin can manage their own login here.
export default async function AdminAccountPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">My Admin Account</h1>
        <p className="mt-2 text-sm text-zinc-400">Change your own password or username.</p>
        <AdminAccountClient username={session.username} />
      </div>
    </div>
  );
}
