import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The ambassador dashboard now lives inside the customer account as the
// "Ambassador Stats" tab (/account/ambassador). This route is kept so old
// links and approval emails still resolve — it forwards there, and that page
// enforces auth + approved-ambassador access.
export default function PartnerDashboardRedirect() {
  redirect("/account/ambassador");
}
