import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { setPartnerPayoutMethod } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

// An approved ambassador sets how they want to be paid: "cash" or "store_credit"
// (worth the configured multiplier). Authorization is by the caller's own
// approved partner profile — they can only change their own preference.
export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const method = body?.method === "store_credit" ? "store_credit" : "cash";
    const applied = await setPartnerPayoutMethod(user.id, method);
    return NextResponse.json({ success: true, payoutMethod: applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update payout method";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
