import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getPartnerByAuthUserId } from "@/lib/partner-portal";
import { customerSafeMessage } from "@/lib/safe-error";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const partner = await getPartnerByAuthUserId(user.id);
    if (!partner) {
      return NextResponse.json({
        success: true,
        partner: null,
      });
    }

    return NextResponse.json({
      success: true,
      partner: {
        id: partner.id,
        status: partner.status,
        referralCode: partner.referral_code,
      },
    });
  } catch (error) {
    // Logged in full; the ambassador sees Vanta's words, never a database or
    // vendor message. A message written for them still passes through.
    console.error("[partner/me]", error);
    const message = customerSafeMessage(error, "Unable to load partner profile");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
