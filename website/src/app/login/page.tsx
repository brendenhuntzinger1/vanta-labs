import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PartnerLoginForm } from "@/components/partner-login-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const metadata: Metadata = {
  title: "Partner Sign In",
  description: "Sign in to the Vanta Labs partner portal.",
  // Transactional/auth surface: robots.ts already disallows these paths, and
  // this is the per-page half of the same statement, exactly as /cart does it.
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  const user = await getAuthenticatedUser();

  if (user) {
    const role = detectRoleFromUser(user);
    if (role === "admin") {
      redirect("/admin/partners");
    }
    if (role === "partner") {
      redirect("/partner/dashboard");
    }
    // A signed-in customer landing on the partner login page is confusing —
    // send them to their account instead of showing a partner form.
    redirect("/account");
  }

  return (
    <div className="min-h-screen bg-[#0b0b0b] px-4 py-14 sm:px-6 lg:px-8">
      <PartnerLoginForm />
    </div>
  );
}
