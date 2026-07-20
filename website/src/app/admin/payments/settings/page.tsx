import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getPaymentMethodsConfig, getCardProcessingFeeConfig } from "@/lib/admin-control";
import { AdminPaymentSettingsClient } from "@/components/admin-payment-settings-client";

export const dynamic = "force-dynamic";

// Lets an admin fill in real account details (Cash App handle, Zelle email/
// phone, PayPal email, QR image paths, instructions) and tune the card fee
// without editing code. Values are stored via the admin-control snapshot and
// override the placeholder defaults in src/lib/payment-methods.ts.
export default async function AdminPaymentSettingsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const [methods, cardFee] = await Promise.all([
    getPaymentMethodsConfig(),
    getCardProcessingFeeConfig(),
  ]);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Payment Settings</h1>
            <p className="mt-2 text-sm text-zinc-400">Configure your payment accounts and the card processing fee. No code required.</p>
          </div>
          <Link href="/admin/payments" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">← Payment Verification</Link>
        </div>

        <AdminPaymentSettingsClient methods={methods} cardFee={cardFee} />
      </div>
    </div>
  );
}
