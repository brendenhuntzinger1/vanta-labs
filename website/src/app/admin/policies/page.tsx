import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getAllPolicies } from "@/lib/legal-content";
import { AdminPoliciesClient } from "@/components/admin-policies-client";

export const dynamic = "force-dynamic";

export default async function AdminPoliciesPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) redirect("/vault");
  if (!canManageSettings(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-zinc-400">
          Your role does not have permission to edit policies.
        </div>
      </div>
    );
  }

  const policies = await getAllPolicies();

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Policies &amp; Legal</h1>
        <p className="mt-2 text-sm text-zinc-400">Edit your Terms, Privacy, Disclaimer, Shipping, Refund, and Cookie policies — changes go live immediately. Have a lawyer review the final text.</p>
        <AdminPoliciesClient policies={policies} />
      </div>
    </div>
  );
}
