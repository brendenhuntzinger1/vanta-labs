import { SiteHeader } from "@/components/site-header";
import { AccountResetPasswordForm } from "@/components/account-reset-password-form";

export default function AccountResetPasswordPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)]">
      <SiteHeader />
      <div className="px-4 py-14 sm:px-6 lg:px-8">
        <AccountResetPasswordForm />
      </div>
    </div>
  );
}
