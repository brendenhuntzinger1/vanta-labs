import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getApprovedPartnerByAuthUserId, updatePartnerPayoutMethod } from "@/lib/partner-portal";
import { customerSafeMessage } from "@/lib/safe-error";

// Lets an APPROVED ambassador set/update their preferred payout method
// (PayPal / Venmo / Cash App + handle). Scoped to the signed-in user's own
// partner profile — the update is keyed by auth_user_id server-side, so a user
// can never write another ambassador's payout info.
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const partner = await getApprovedPartnerByAuthUserId(user.id);
    if (!partner) {
      return NextResponse.json({ success: false, error: "Partner account not approved yet" }, { status: 403 });
    }

    const body = (await request.json()) as { method?: string; handle?: string };
    await updatePartnerPayoutMethod(user.id, String(body.method ?? ""), String(body.handle ?? ""));

    return NextResponse.json({ success: true });
  } catch (error) {
    // The payout validation messages are CustomerFacingError and pass through;
    // anything else (a Postgres constraint, a vendor hostname) is replaced.
    console.error("[partner/payout-method]", error);
    const message = customerSafeMessage(error, "Unable to save payout method");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
