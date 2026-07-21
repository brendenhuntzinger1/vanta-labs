import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { AccountAuthForm } from "@/components/account-auth-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Only allow internal, single-slash paths as a post-login destination — never
// an absolute URL — to prevent open-redirect abuse.
function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  return "/account";
}

export default async function AccountLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const destination = safeNext(next);
  const user = await getAuthenticatedUser();

  if (user && detectRoleFromUser(user) === "customer") {
    redirect(destination);
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)]">
      <SiteHeader />
      <div className="px-4 py-14 sm:px-6 lg:px-8">
        <Suspense fallback={null}>
          <AccountAuthForm />
        </Suspense>
      </div>
    </div>
  );
}
