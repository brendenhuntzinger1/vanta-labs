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
    <div className="min-h-screen bg-[#0b0b0b] px-4 py-14 sm:px-6 lg:px-8">
      <PartnerLoginForm />
    </div>
  );
}
