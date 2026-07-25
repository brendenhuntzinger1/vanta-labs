import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { isApprovedAmbassadorCustomer } from "@/lib/ambassador-status";
import { getReferralProgramConfig } from "@/lib/admin-control";

// Drives the "Ambassador X% off" line in the checkout preview. Returns the
// personal discount percent an approved ambassador gets on their OWN order (0
// for everyone else). Any authenticated role may call it — an ambassador's
// account is a "partner", not a "customer", so this is deliberately separate
// from /api/account/me. Uses the SAME check + config as the authoritative
// checkout total so the preview and the real charge can never diverge.
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: true, percent: 0 });
  }

  try {
    const [program, isAmbassador] = await Promise.all([
      getReferralProgramConfig(),
      isApprovedAmbassadorCustomer(user.id, user.email ?? ""),
    ]);

    const percent = program.enabled && isAmbassador && program.personalDiscountPercent > 0
      ? program.personalDiscountPercent
      : 0;

    return NextResponse.json({ success: true, percent });
  } catch {
    // Never block checkout over this — just show no ambassador discount.
    return NextResponse.json({ success: true, percent: 0 });
  }
}
