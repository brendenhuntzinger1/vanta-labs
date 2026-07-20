import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { startMembershipSignup } from "@/lib/membership-billing";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as { tierId?: string; billingCycle?: string; agreedToTerms?: boolean } | null;

  if (!body?.tierId || (body.billingCycle !== "monthly" && body.billingCycle !== "annual")) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  if (body.agreedToTerms !== true) {
    return NextResponse.json({ success: false, error: "You must agree to the recurring billing terms to continue." }, { status: 400 });
  }

  try {
    const result = await startMembershipSignup({ userId: user.id, tierId: body.tierId, billingCycle: body.billingCycle });
    return NextResponse.json({ success: true, chargeSucceeded: result.success });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unable to start membership" }, { status: 400 });
  }
}
