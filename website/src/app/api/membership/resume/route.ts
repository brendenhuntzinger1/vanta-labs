import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { resumeMembership } from "@/lib/membership-billing";

export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await resumeMembership(user.id);
    return NextResponse.json({ success: true, status: result.status, nextBillingAt: result.nextBillingAt });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unable to resume membership" }, { status: 400 });
  }
}
