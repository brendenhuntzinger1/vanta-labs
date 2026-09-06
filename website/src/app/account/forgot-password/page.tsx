import type { Metadata } from "next";
import { AccountForgotPasswordForm } from "@/components/account-forgot-password-form";

export const metadata: Metadata = {
  title: "Reset Your Password",
  description: "Request a password reset link for your Vanta Labs account.",
  // Transactional/auth surface: robots.ts already disallows these paths, and
  // this is the per-page half of the same statement, exactly as /cart does it.
  robots: { index: false, follow: false },
};

export default function AccountForgotPasswordPage() {
  // NO SITE HEADER, for the same reason the portal has none: every link in
  // it — the wordmark, Products, COA Library, Membership, Account — requires
  // an account, and the person on this page is here BECAUSE they cannot get
  // into theirs. All five bounce straight back to the sign-in form. The form
  // below carries its own way back.
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.08),transparent_55%),linear-gradient(140deg,#05070f_0%,#0a1020_55%,#060910_100%)]">
      <div className="px-4 py-14 sm:px-6 lg:px-8">
        <AccountForgotPasswordForm />
      </div>
    </div>
  );
}
