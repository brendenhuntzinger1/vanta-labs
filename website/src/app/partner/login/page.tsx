import { redirect } from "next/navigation";
import { PartnerLoginForm } from "@/components/partner-login-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export default async function PartnerLoginPage() {
  const user = await getAuthenticatedUser();

  if (user) {
    const role = detectRoleFromUser(user);
    if (role === "admin") {
      redirect("/admin/partners");
    }
    if (role === "partner") {
      redirect("/partner/dashboard");
    }
  }

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.1),transparent_52%),linear-gradient(145deg,#05070f_0%,#0c1426_50%,#070b12_100%)] px-4 py-14 sm:px-6 lg:px-8">
      <PartnerLoginForm />
    </div>
  );
}
