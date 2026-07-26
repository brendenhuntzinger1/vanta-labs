import { ReactNode } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Checkout is a private, transactional page — keep it out of the index even if
// a URL leaks externally (robots.txt Disallow blocks crawling but not indexing
// of linked URLs; noindex is the robust guard). Applies to the client page.tsx.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Checkout requires a signed-in customer account (guest checkout is off).
// Browsing the store stays open to everyone; only the checkout is gated, so
// SEO and product discovery are unaffected. Unauthenticated shoppers are sent
// to sign in and returned to checkout afterward.
export default async function CheckoutLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();

  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login?next=/checkout");
  }

  return <>{children}</>;
}
