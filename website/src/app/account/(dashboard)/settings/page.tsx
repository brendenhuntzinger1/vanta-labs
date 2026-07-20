import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerPreferences } from "@/lib/customer-account";
import { AccountSettingsClient } from "@/components/account-settings-client";

export default async function AccountSettingsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const preferences = await getCustomerPreferences(user.id);
  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h1 className="text-2xl font-semibold text-white">Account Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">Update your profile, password, and email notification preferences.</p>
      </section>

      <AccountSettingsClient
        initialFullName={fullName}
        initialEmail={user.email ?? ""}
        initialPreferences={preferences}
      />
    </div>
  );
}
