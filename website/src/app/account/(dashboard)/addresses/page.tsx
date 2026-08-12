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

  // Degrade gracefully on a transient DB error rather than crashing the route.
  const addresses = await getCustomerAddresses(user.id).catch(() => []);

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Saved addresses</h1>
        {/* Checkout does not read these yet (it collects the address on the
            page, including a State the address book has no column for), so this
            promised a convenience the customer never got. */}
        <p className="mt-2 text-sm text-zinc-400">Keep your delivery addresses on file for reference.</p>
      </header>

      <AccountAddressesClient initialAddresses={addresses} />
    </div>
  );
}
