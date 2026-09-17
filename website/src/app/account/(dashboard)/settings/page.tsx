import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerPreferences, getCustomerAddresses } from "@/lib/customer-account";
import { AccountSettingsClient } from "@/components/account-settings-client";
import { hasPasswordIdentity } from "@/lib/account-identity";
import { readSmsSubscriptionForAccount } from "@/lib/sms-consent";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const [preferences, addresses, smsStanding] = await Promise.all([
    getCustomerPreferences(user.id),
    getCustomerAddresses(user.id).catch(() => []),
    readSmsSubscriptionForAccount(user.email ?? ""),
  ]);

  // THE PAGE MUST NOT CONTRADICT THE CONSENT LEDGER. `customer_preferences`
  // only carries a tick taken while signed in; a guest checkout writes the
  // address's own row instead. Reading both means somebody who subscribed at
  // the till sees their real subscription here rather than an empty box.
  const shownPreferences = smsStanding.subscribed && !preferences.smsMarketing
    ? { ...preferences, smsMarketing: true, phone: preferences.phone || smsStanding.phone }
    : preferences;
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
        initialPreferences={shownPreferences}
        initialAddresses={addresses}
        hasPassword={hasPasswordIdentity(user)}
      />
    </div>
  );
}
