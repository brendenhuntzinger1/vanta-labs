import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerAddresses } from "@/lib/customer-account";
import { AccountAddressesClient } from "@/components/account-addresses-client";

export default async function AccountAddressesPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const addresses = await getCustomerAddresses(user.id);

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h1 className="text-2xl font-semibold text-white">Saved Addresses</h1>
        <p className="mt-2 text-sm text-zinc-400">Manage shipping addresses used to pre-fill checkout.</p>
      </section>

      <AccountAddressesClient initialAddresses={addresses} />
    </div>
  );
}
