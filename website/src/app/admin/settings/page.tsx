import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { getPaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import { getFulfillmentAdminSettings } from "@/lib/fulfillment/config";
import { AdminSettingsClient } from "@/components/admin-settings-client";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  if (!canManageSettings(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-zinc-400">
          Your role does not have permission to manage settings. Ask a manager or super admin.
        </div>
      </div>
    );
  }

  const [email, processor, fulfillment] = await Promise.all([
    getEmailAdminSettings(),
    getPaymentProcessorAdminSettings(),
    getFulfillmentAdminSettings(),
  ]);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">Connect email, your card payment processor, and your 3PL. Everything else works without these.</p>
        <AdminSettingsClient email={email} processor={processor} fulfillment={fulfillment} />
      </div>
    </div>
  );
}
