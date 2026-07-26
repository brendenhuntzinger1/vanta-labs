import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getWishlistSlugs } from "@/lib/customer-account";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { AccountWishlistClient } from "@/components/account-wishlist-client";

export default async function AccountWishlistPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  // Degrade gracefully on a transient DB error rather than throwing the whole
  // account route to the error boundary — an empty wishlist is recoverable.
  const slugs = await getWishlistSlugs(user.id).catch(() => [] as string[]);
  const products = await getCatalogProductsBySlugs(slugs).catch(() => []);

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h1 className="text-2xl font-semibold text-white">Wishlist</h1>
        <p className="mt-2 text-sm text-zinc-400">{products.length} saved item{products.length === 1 ? "" : "s"}.</p>
      </section>

      <AccountWishlistClient products={products} />
    </div>
  );
}
