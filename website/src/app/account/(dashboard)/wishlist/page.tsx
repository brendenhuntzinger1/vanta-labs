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
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Wishlist</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {products.length === 0 ? "Save products to keep an eye on them." : `${products.length} saved item${products.length === 1 ? "" : "s"} · add to cart in one tap.`}
        </p>
      </header>

      <AccountWishlistClient products={products} />
    </div>
  );
}
