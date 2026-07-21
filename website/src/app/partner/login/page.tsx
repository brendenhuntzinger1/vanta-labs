import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Ambassadors are ordinary customer accounts, so there is no separate partner
// login. This route forwards to the single account sign-in for old links.
export default function PartnerLoginRedirect() {
  redirect("/account/login");
}
