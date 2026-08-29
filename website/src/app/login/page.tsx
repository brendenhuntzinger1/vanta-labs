import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Ambassadors are ordinary customer accounts, so there is no separate partner
// login. /partner/login has said exactly that, and forwarded to the single
// account sign-in, for a while. This route did not: it rendered its own
// "Partner Portal — Secure Login" form asking for "your approved partner
// credentials", which do not exist.
//
// Worse, that form was a DEAD END (audit E3). It carried no "Forgot your
// password?", no "Resend confirmation email" and no Turnstile token, so an
// affiliate who reached it and could not sign in had no route out — and the
// day a CAPTCHA secret is set in the Supabase dashboard, every tokenless call
// from it would start being rejected with no code change to point at.
//
// Nothing in the app ever linked here; it was reachable only by bookmark or an
// old link, which is exactly the returning-affiliate case it failed. Forwarding
// to the single account sign-in gives those visitors the full form.
export default function LegacyPartnerLoginRedirect() {
  redirect("/account/login");
}
