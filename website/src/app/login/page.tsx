import { redirect } from "next/navigation";
import { PartnerLoginForm } from "@/components/partner-login-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

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
  }

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)] px-4 py-14 sm:px-6 lg:px-8">
      <PartnerLoginForm />
    </div>
  );
}
