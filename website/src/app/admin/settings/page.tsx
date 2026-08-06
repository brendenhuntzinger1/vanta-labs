import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { getPaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import { getFulfillmentAdminSettings } from "@/lib/fulfillment-settings";
import { getInventoryReadiness, type InventoryReadiness } from "@/lib/admin-inventory";
import { listPackagePresets } from "@/lib/shippo/packages";
import { getConfiguredReturnAddress, getShippingAddresses } from "@/lib/shipping-origin";
import { getBusinessSettings, getWelcomeOffer } from "@/lib/admin-control";
import { getSiteUrl } from "@/lib/env";
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

  const [email, processor, fulfillment, business, welcomeOffer, packages, addresses, configuredReturn, readiness] =
    await Promise.all([
      getEmailAdminSettings(),
      getPaymentProcessorAdminSettings(),
      getFulfillmentAdminSettings(),
      getBusinessSettings(),
      getWelcomeOffer(),
      // Retired boxes are included so the settings screen can show and restore
      // them; the order picker asks for active ones only.
      listPackagePresets({ includeInactive: true }),
      getShippingAddresses(),
      // The CONFIGURED return address, not the resolved one. getShippingAddresses()
      // falls the return address back to the origin for Shippo's benefit, and
      // rendering that fallback in the form would let a plain Save persist the
      // origin as a deliberate separate return address.
      getConfiguredReturnAddress(),
      // Measured here so the enforcement warning is on screen before the
      // operator reaches for the switch. It is measured AGAIN, server-side,
      // when the switch is ticked and once more at save — this render is the
      // one reading that can go stale.
      getInventoryReadiness().catch((): InventoryReadiness | null => null),
    ]);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">Connect email and your card payment processor. Everything else works without these.</p>
        <AdminSettingsClient
          email={email}
          processor={processor}
          fulfillment={fulfillment}
          business={business}
          welcomeOffer={welcomeOffer}
          siteUrl={getSiteUrl()}
          inventoryReadiness={readiness}
          packages={packages}
          shippingOrigin={addresses.origin}
          shippingReturnAddress={configuredReturn}
          usesSeparateReturnAddress={addresses.usesSeparateReturn}
          shippingOriginMissing={addresses.originValidation.missing}
          canManage={canManageSettings(session.role)}
        />
      </div>
    </div>
  );
}
