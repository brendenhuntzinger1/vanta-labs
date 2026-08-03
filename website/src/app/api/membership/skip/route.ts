import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { skipNextBilling } from "@/lib/membership-billing";
import { customerSafeMessage } from "@/lib/safe-error";

export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await skipNextBilling(user.id);
    return NextResponse.json({ success: true, status: result.status, nextBillingAt: result.nextBillingAt });
  } catch (error) {
    return NextResponse.json({ success: false, error: customerSafeMessage(error, "Unable to skip the next charge") }, { status: 400 });
  }
}
