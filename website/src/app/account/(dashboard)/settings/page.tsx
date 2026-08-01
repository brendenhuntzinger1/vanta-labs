import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerPreferences, getCustomerAddresses } from "@/lib/customer-account";
import { AccountSettingsClient } from "@/components/account-settings-client";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const [preferences, addresses] = await Promise.all([
    getCustomerPreferences(user.id),
    getCustomerAddresses(user.id).catch(() => []),
  ]);
  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">Manage your profile, security, addresses, payments, notifications, and privacy.</p>
      </header>

      <AccountSettingsClient
        initialFullName={fullName}
        initialEmail={user.email ?? ""}
        initialPreferences={preferences}
        initialAddresses={addresses}
      />
    </div>
  );
}
