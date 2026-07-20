import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import { getMembershipBonusSettings } from "@/lib/membership";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await getMembershipBonusSettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage membership settings." }, { status: 403 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);

    const entries: Array<[string, unknown]> = [
      ["signup_bonus_enabled", body.signupBonusEnabled],
      ["referral_bonus_enabled", body.referralBonusEnabled],
      ["birthday_bonus_enabled", body.birthdayBonusEnabled],
      ["signup_bonus_points", body.signupBonusPoints],
      ["referral_bonus_points", body.referralSignupBonusPoints],
      ["birthday_bonus_points", body.birthdayBonusPoints],
    ];

    for (const [key, value] of entries) {
      if (value === undefined) continue;
      await upsertControlValue({
        section: "membership",
        key,
        value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
