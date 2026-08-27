import type { Metadata } from "next";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { AccountResetPasswordForm } from "@/components/account-reset-password-form";

export const metadata: Metadata = {
  title: "Choose a New Password",
  description: "Set a new password for your Vanta Labs account.",
  // Transactional/auth surface: robots.ts already disallows these paths, and
  // this is the per-page half of the same statement, exactly as /cart does it.
  robots: { index: false, follow: false },
};

export default function AccountResetPasswordPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)]">
      <SiteHeaderV2 />
      <div className="px-4 py-14 sm:px-6 lg:px-8">
        <AccountResetPasswordForm />
      </div>
    </div>
  );
}
