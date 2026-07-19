import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getPartnerByAuthUserId } from "@/lib/partner-portal";

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
    const message = error instanceof Error ? error.message : "Unable to load partner profile";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
